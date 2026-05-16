#!/usr/bin/env node
import { config } from "dotenv";
config();

import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { searchFlights } from "./src/tequila.js";

const app = express();
app.use(express.json());
app.use(express.static("public"));

// Call Claude via SDK (Render) or CLI (local dev fallback)
async function askClaude(prompt) {
  if (process.env.ANTHROPIC_API_KEY) {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    return msg.content[0].text;
  }

  // Local dev: use Claude Code CLI (key lives in OS keychain)
  const bin = existsSync("/Users/atungc/.local/bin/claude")
    ? "/Users/atungc/.local/bin/claude"
    : "claude";
  return execSync(`${bin} -p ${JSON.stringify(prompt)}`, {
    encoding: "utf8",
    timeout: 90000,
  }).trim();
}

function parseJson(raw) {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No JSON object found in response");
  return JSON.parse(m[0]);
}

async function getFlights({ from, to, date, adults }) {
  // Try Tequila live data first
  if (process.env.TEQUILA_API_KEY) {
    try {
      const flights = await searchFlights({ from, to, date, adults, apiKey: process.env.TEQUILA_API_KEY });
      if (flights?.length) {
        // Recommend from live data
        const prompt = `You are a personal travel advisor. Pick the best flight. Make a call — no hedging.

FLIGHTS:
${flights.map((f, i) => `[${i}] ${f.carrier} ${f.flight}: departs ${f.departs}, arrives ${f.arrives} (${f.duration}), $${f.price_usd}, ${f.stops === 0 ? "direct" : f.stops + " stop(s)"}`).join("\n")}

Respond with ONLY valid JSON:
{ "winner_index": 0, "runnerup_index": 1, "reason": "One sentence with real numbers." }`.trim();

        const raw = await askClaude(prompt);
        const { winner_index: wi, runnerup_index: ri, reason } = parseJson(raw);
        return { flights, winner: flights[wi], runnerup: flights[Math.min(ri, flights.length - 1)], reason };
      }
    } catch { /* fall through to AI generation */ }
  }

  // AI-generated flights + recommendation in one call
  const prompt = `You are a personal travel advisor and flight data expert.

Generate 4 realistic one-way flight options from ${from} to ${to} on ${date} for ${adults} adult${adults > 1 ? "s" : ""}, then pick the best one.

Use real airlines that fly this route. Use realistic 2026 times and USD prices. Include a mix: cheapest, fastest, a premium carrier, and optionally one with a stop.

Respond with ONLY valid JSON — no markdown:
{
  "flights": [
    { "carrier": "Airline Name", "flight": "XX000", "departs": "HH:MM", "arrives": "HH:MM", "duration": "XhYYm", "stops": 0, "price_usd": 000, "booking_url": "https://www.airline.com" }
  ],
  "winner_index": 0,
  "runnerup_index": 1,
  "reason": "One sentence with real numbers explaining the pick."
}`.trim();

  const raw = await askClaude(prompt);
  const { flights, winner_index: wi, runnerup_index: ri, reason } = parseJson(raw);
  return { flights, winner: flights[wi], runnerup: flights[Math.min(ri, flights.length - 1)], reason };
}

async function getHotels({ to, date, nights, adults }) {
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
    { "name": "Hotel Name", "area": "Neighborhood", "stars": 4, "rating": 8.5, "price_per_night_usd": 120, "booking_url": "https://www.booking.com/hotel/jp/example.html" }
  ],
  "winner_index": 0,
  "runnerup_index": 1,
  "reason": "One sentence with real numbers explaining the pick."
}`.trim();

  const raw = await askClaude(prompt);
  const { city, hotels, winner_index: wi, runnerup_index: ri, reason } = parseJson(raw);
  return { city, hotels, winner: hotels[wi], runnerup: hotels[Math.min(ri, hotels.length - 1)], reason };
}

// POST /api/search
app.post("/api/search", async (req, res) => {
  const { from, to, date, nights = 4, adults = 1 } = req.body;

  if (!from || !to || !date) {
    return res.status(400).json({ error: "from, to, and date are required" });
  }

  const depart = new Date(date);
  const returnDate = new Date(depart);
  returnDate.setDate(returnDate.getDate() + Number(nights));
  const datesLabel = `${depart.toLocaleDateString("en-US", { month: "short", day: "numeric" })}–${returnDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

  try {
    // Run flights and hotels in parallel
    const [flightResult, hotelResult] = await Promise.all([
      getFlights({ from, to, date, adults }),
      getHotels({ to, date, nights, adults }),
    ]);

    res.json({ ...flightResult, hotel: hotelResult, datesLabel });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3004;
app.listen(PORT, () => console.log(`Travel Advisor running at http://localhost:${PORT}`));
