#!/usr/bin/env node
import { config } from "dotenv";
config();

import express from "express";
import OpenAI from "openai";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { searchFlights } from "./src/tequila.js";
import { searchFlightsAmadeus } from "./src/amadeus.js";
import { getFlightPrices, aviasalesUrl } from "./src/travelpayouts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

const nvidia = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: "https://integrate.api.nvidia.com/v1",
});

async function askClaude(prompt) {
  const resp = await nvidia.chat.completions.create({
    model: "meta/llama-3.3-70b-instruct",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });
  return resp.choices[0].message.content;
}

function parseJson(raw) {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No JSON object found in response");
  return JSON.parse(m[0]);
}

function bookingUrl(hotelName, city, checkIn, checkOut, adults) {
  const q = encodeURIComponent(`${hotelName} ${city}`);
  return `https://www.booking.com/searchresults.html?ss=${q}&checkin=${checkIn}&checkout=${checkOut}&group_adults=${adults}&no_rooms=1&selected_currency=USD`;
}

// POST /api/parse — convert natural language into trip fields
app.post("/api/parse", async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "text is required" });

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Extract trip details from this text: "${text}"

Today is ${today}.

Respond with ONLY valid JSON — no markdown:
{
  "from": "IATA code or null",
  "to": "IATA code or null",
  "date": "YYYY-MM-DD or null",
  "nights": number or null,
  "adults": number or null
}

Rules:
- Convert city/country names to their main airport IATA code (Taipei→TPE, Tokyo→NRT, Osaka→KIX, Bangkok→BKK, Seoul→ICN, Singapore→SIN, London→LHR, Paris→CDG, NYC→JFK, LA→LAX)
- If a month is mentioned without a year, use its next occurrence from today
- If "next week / next month" use a reasonable date
- "weekend" → nearest upcoming Friday
- Leave fields null if genuinely unclear`.trim();

  try {
    const raw = await askClaude(prompt);
    res.json(parseJson(raw));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function getFlights({ from, to, date, adults, preferences = "" }) {
  // 1. Try Travelpayouts (real prices, last 48h) — enrich + supplement via AI
  if (process.env.TRAVELPAYOUTS_TOKEN) {
    try {
      const flights = await getFlightPrices({ from, to, date, token: process.env.TRAVELPAYOUTS_TOKEN });
      if (flights?.length >= 3) return await enrichAndRecommend(flights, { from, to, date, adults, preferences });
    } catch { /* fall through */ }
  }

  // 2. Try Amadeus (real prices + full schedule)
  if (process.env.AMADEUS_CLIENT_ID && process.env.AMADEUS_CLIENT_SECRET) {
    try {
      const flights = await searchFlightsAmadeus({
        from, to, date, adults,
        clientId: process.env.AMADEUS_CLIENT_ID,
        clientSecret: process.env.AMADEUS_CLIENT_SECRET,
      });
      if (flights?.length) return await enrichAndRecommend(flights, { from, to, date, adults, preferences });
    } catch { /* fall through */ }
  }

  // 3. Try Tequila
  if (process.env.TEQUILA_API_KEY) {
    try {
      const flights = await searchFlights({ from, to, date, adults, apiKey: process.env.TEQUILA_API_KEY });
      if (flights?.length) return await enrichAndRecommend(flights, { from, to, date, adults, preferences });
    } catch { /* fall through */ }
  }

  // 4. AI-generated flights + recommendation
  const prefLine = preferences ? `\nTraveler preferences: ${preferences}` : "";
  const prompt = `You are a personal travel advisor and flight data expert.

Generate 6 diverse one-way flight options from ${from} to ${to} on ${date} for ${adults} adult${adults > 1 ? "s" : ""}, then pick the best one.

Cover these distinct archetypes — use real airlines that actually operate this route:
1. Cheapest option (may have 2 stops if it saves significantly)
2. Fastest direct flight
3. Best value: reasonable price + total trip under 16h
4. Premium/full-service nonstop or 1 short stop
5. Asian hub connector (via HKG/SIN/BKK/NRT/ICN) — layover ≥2h
6. Alternative routing (different hub, LCC, or minority carrier on this route)${prefLine}

Use realistic 2026 USD prices and departure times. For stopped flights, include layover city and duration (aim ≥2h).

Respond with ONLY valid JSON — no markdown:
{
  "flights": [
    {
      "carrier": "Airline Name",
      "flight": "XX000",
      "departs": "HH:MM",
      "arrives": "HH:MM",
      "duration": "XhYYm",
      "stops": 0,
      "price_usd": 000,
      "booking_url": "https://www.airline.com",
      "layovers": []
    }
  ],
  "winner_index": 0,
  "runnerup_index": 1,
  "reason": "One sentence with real numbers explaining the pick."
}

Layover format: [{ "airport": "HKG", "city": "Hong Kong", "duration": "2h30m", "durationMinutes": 150 }]`.trim();

  const raw = await askClaude(prompt);
  const { flights, winner_index: wi, runnerup_index: ri, reason } = parseJson(raw);

  const enriched = flights.map(f => ({
    ...f,
    layovers: f.layovers ?? [],
    aviasales_url: aviasalesUrl(from, to, date, adults),
  }));

  return { flights: enriched, winner: enriched[wi], runnerup: enriched[Math.min(ri, enriched.length - 1)], reason };
}

// Use real cached prices as anchors, then have AI assign real airlines/times/layovers
// and supplement to 6 diverse options, then pick a winner.
async function enrichAndRecommend(realFlights, { from, to, date, adults, preferences = "" }) {
  const prefLine = preferences ? `\nTraveler preferences: ${preferences}` : "";

  // Build price anchor list (real prices — use as constraints, not suggestions)
  const anchors = realFlights
    .filter(f => f.price_usd)
    .slice(0, 6)
    .map(f => `$${f.price_usd} / ${f.stops === 0 ? "direct" : f.stops + " stop(s)"} / ~${f.duration ?? "?"}`)
    .join("\n");

  const prompt = `You are a flight scheduling expert. Real cached prices for ${from}→${to} around ${date}:

${anchors}

Using these price points as constraints, generate 6 diverse one-way flight options for ${adults} adult${adults > 1 ? "s" : ""} departing ${date}. Cover distinct archetypes:
1. Cheapest (match or beat the lowest cached price — may have 2 stops)
2. Fastest direct
3. Best value: good price + total under 16h
4. Premium nonstop (full-service carrier)
5. Asian hub connector (via HKG/SIN/BKK/NRT/ICN — layover ≥2h)
6. Alternative routing (different hub, LCC, or lesser-known carrier)${prefLine}

Assign real airlines that actually fly ${from}→${to}. Use realistic 2026 departure/arrival times (HH:MM).

Respond with ONLY valid JSON — no markdown:
{
  "flights": [
    {
      "carrier": "Airline Name",
      "flight": "XX000",
      "departs": "HH:MM",
      "arrives": "HH:MM",
      "duration": "XhYYm",
      "stops": 0,
      "price_usd": 000,
      "booking_url": "https://www.airline.com",
      "layovers": []
    }
  ],
  "winner_index": 0,
  "runnerup_index": 1,
  "reason": "One sentence with real numbers."
}

Layover: [{ "airport": "HKG", "city": "Hong Kong", "duration": "2h30m", "durationMinutes": 150 }]`.trim();

  const raw = await askClaude(prompt);
  const { flights, winner_index: wi, runnerup_index: ri, reason } = parseJson(raw);

  const enriched = flights.map(f => ({
    ...f,
    layovers: f.layovers ?? [],
    aviasales_url: aviasalesUrl(from, to, date, adults),
  }));

  return { flights: enriched, winner: enriched[wi], runnerup: enriched[Math.min(ri, enriched.length - 1)], reason };
}



async function getHotels({ to, date, nights, adults, preferences = "" }) {
  const checkOut = new Date(date);
  checkOut.setDate(checkOut.getDate() + Number(nights));
  const checkOutStr = checkOut.toISOString().slice(0, 10);

  const stayType = Number(nights) <= 2
    ? `near the airport (convenience matters for a short ${nights}-night stay)`
    : `in the city center or a well-connected neighborhood (NOT airport hotels — the traveler wants to experience the city for ${nights} nights)`;

  const prompt = `You are a hotel expert. Generate 3 realistic hotel options ${stayType} for destination ${to}, check-in ${date}, check-out ${checkOutStr}, for ${adults} adult${adults > 1 ? "s" : ""}.

Use real hotels that exist in this city. Use realistic 2026 USD prices per night. You MUST include exactly three tiers with a meaningful price spread:
- Budget: a clean, well-rated option (aim for the lower 25% of typical prices for this city)
- Mid-range: a comfortable 3–4 star in a good location (aim for the middle 50%)
- Premium: a notable 4–5 star hotel (aim for the upper 25%)
The three prices must be clearly distinct — no two options should be within 20% of each other.

Respond with ONLY valid JSON — no markdown:
{
  "city": "City Name",
  "hotels": [
    { "name": "Hotel Name", "area": "Neighborhood", "stars": 4, "rating": 8.5, "price_per_night_usd": 120 }
  ],
  "winner_index": 0,
  "runnerup_index": 1,
  "reason": "One sentence with real numbers explaining the pick."
}`.trim();

  const prefLine = preferences ? `\nTraveler preferences: ${preferences}` : "";
  const fullPrompt = prompt + prefLine;
  const raw = await askClaude(fullPrompt);
  const { city, hotels, winner_index: wi, runnerup_index: ri, reason } = parseJson(raw);

  const enriched = hotels.map(h => ({
    ...h,
    booking_url: bookingUrl(h.name, city, date, checkOutStr, adults),
  }));

  return { city, hotels: enriched, winner: enriched[wi], runnerup: enriched[Math.min(ri, enriched.length - 1)], reason };
}

// POST /api/search
app.post("/api/search", async (req, res) => {
  const { from, to, date, nights = 4, adults = 1, preferences = "",
          tripType = "oneway", returnDate, legs } = req.body;

  function fmt(d) {
    return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  try {
    if (tripType === "roundtrip") {
      if (!from || !to || !date || !returnDate)
        return res.status(400).json({ error: "from, to, date, and returnDate are required" });
      const nightsRT = Math.max(1, Math.round((new Date(returnDate) - new Date(date)) / 86400000));
      const [outbound, ret, hotel] = await Promise.all([
        getFlights({ from, to, date, adults, preferences }),
        getFlights({ from: to, to: from, date: returnDate, adults, preferences }),
        getHotels({ to, date, nights: nightsRT, adults, preferences }),
      ]);
      return res.json({
        tripType: "roundtrip", outbound, return: ret, hotel,
        datesLabel: `${fmt(date)} – ${fmt(returnDate)}`,
        nights: nightsRT, adults: Number(adults),
      });

    } else if (tripType === "multicity") {
      if (!legs?.length || legs.length < 2)
        return res.status(400).json({ error: "at least 2 legs required for multi-city" });
      for (const leg of legs)
        if (!leg.from || !leg.to || !leg.date)
          return res.status(400).json({ error: "each leg requires from, to, and date" });
      const legResults = await Promise.all(
        legs.map(leg => getFlights({ from: leg.from, to: leg.to, date: leg.date, adults, preferences }))
      );
      return res.json({
        tripType: "multicity",
        legs: legs.map((leg, i) => ({ ...leg, ...legResults[i] })),
        datesLabel: `${legs[0].from}→${legs.map(l => l.to).join("→")}`,
        adults: Number(adults),
      });

    } else {
      if (!from || !to || !date)
        return res.status(400).json({ error: "from, to, and date are required" });
      const dep = new Date(date), ret2 = new Date(dep);
      ret2.setDate(ret2.getDate() + Number(nights));
      const datesLabel = `${dep.toLocaleDateString("en-US",{month:"short",day:"numeric"})}–${ret2.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}`;
      const [flightResult, hotelResult] = await Promise.all([
        getFlights({ from, to, date, adults, preferences }),
        getHotels({ to, date, nights, adults, preferences }),
      ]);
      return res.json({ tripType: "oneway", ...flightResult, hotel: hotelResult, datesLabel, nights: Number(nights), adults: Number(adults) });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3004;
app.listen(PORT, () => console.log(`Travel Advisor running at http://localhost:${PORT}`));
