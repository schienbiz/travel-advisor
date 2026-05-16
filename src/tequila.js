// Kiwi/Tequila flight search API client
// Docs: https://tequila.kiwi.com/portal/docs/tequila-api/search_api
// Sign up: https://tequila.kiwi.com/portal/register
// Free tier: no credit card required

const TEQUILA_BASE = "https://api.tequila.kiwi.com/v2/search";

// Tequila returns IATA airline codes — map the common Asia-Pacific ones
const AIRLINE_NAMES = {
  BR: "EVA Air",
  CI: "China Airlines",
  JX: "Starlux Airlines",
  NH: "ANA",
  JL: "Japan Airlines",
  MM: "Peach Aviation",
  IT: "Tigerair Taiwan",
  OZ: "Asiana Airlines",
  KE: "Korean Air",
  SQ: "Singapore Airlines",
  CX: "Cathay Pacific",
  MH: "Malaysia Airlines",
  TG: "Thai Airways",
  VN: "Vietnam Airlines",
  GA: "Garuda Indonesia",
  MU: "China Eastern",
  CA: "Air China",
  HO: "Juneyao Airlines",
  "3U": "Sichuan Airlines",
};

// Tequila stores local departure/arrival times as Unix timestamps expressed in UTC
// (i.e. if the flight departs at 14:00 local time, dTime encodes 14:00 UTC).
// Format as UTC HH:MM to get the correct local display time.
function fmtTime(unixTimestamp) {
  return new Date(unixTimestamp * 1000).toISOString().slice(11, 16);
}

function fmtDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${h}h`;
}

function airlineName(code) {
  return AIRLINE_NAMES[code] ?? code;
}

/**
 * Search for one-way flights using the Tequila API.
 *
 * @param {object} opts
 * @param {string} opts.from       - Origin IATA code (e.g. "TPE")
 * @param {string} opts.to         - Destination IATA code (e.g. "NRT") or city code (e.g. "TYO")
 * @param {string} opts.date       - Departure date, YYYY-MM-DD
 * @param {number} [opts.adults]   - Number of adult passengers (default 1)
 * @param {number} [opts.maxStops] - Max stopovers: 0 = direct only, 1 = up to 1 stop (default 1)
 * @param {number} [opts.limit]    - Max results to fetch (default 5)
 * @param {string} opts.apiKey     - Tequila API key
 *
 * @returns {Promise<Array>} Normalised flight objects ready to pass to Claude
 */
export async function searchFlights({
  from,
  to,
  date,
  adults = 1,
  maxStops = 1,
  limit = 5,
  apiKey,
}) {
  if (!apiKey) throw new Error("TEQUILA_API_KEY is not set");

  // Tequila date format: DD/MM/YYYY
  const [y, m, d] = date.split("-");
  const tequilaDate = `${d}/${m}/${y}`;

  const params = new URLSearchParams({
    fly_from: from,
    fly_to: to,
    date_from: tequilaDate,
    date_to: tequilaDate,   // exact date — same start and end
    adults: String(adults),
    curr: "USD",
    sort: "price",
    limit: String(limit),
    max_stopovers: String(maxStops),
    flight_type: "oneway",
    one_for_city: "1",      // one result per carrier (avoids 5 China Airlines variants)
  });

  const res = await fetch(`${TEQUILA_BASE}?${params}`, {
    headers: { apikey: apiKey },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tequila API ${res.status}: ${body}`);
  }

  const json = await res.json();

  if (!json.data?.length) {
    return [];
  }

  return json.data.map((f) => {
    const firstLeg = f.route[0];
    const lastLeg = f.route[f.route.length - 1];
    const stops = f.route.length - 1;
    const primaryAirline = firstLeg.airline ?? f.airlines?.[0] ?? "??";

    return {
      carrier: airlineName(primaryAirline),
      flight: firstLeg.flight_no ?? `${primaryAirline}???`,
      departs: fmtTime(firstLeg.dTime),
      arrives: fmtTime(lastLeg.aTime),
      duration: fmtDuration(f.duration.departure),
      stops,
      price_usd: Math.round(f.price),
      booking_url: f.deep_link,
    };
  });
}
