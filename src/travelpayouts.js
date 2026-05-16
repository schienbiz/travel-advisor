// Travelpayouts Flights Data API — real prices from last 48h
// Sign up (free): https://travelpayouts.com → Data API → Get token
// Docs: https://support.travelpayouts.com/hc/en-us/articles/203956143

const BASE = "https://api.travelpayouts.com";

const AIRLINE_NAMES = {
  BR: "EVA Air", CI: "China Airlines", JX: "Starlux Airlines",
  NH: "ANA", JL: "Japan Airlines", MM: "Peach Aviation",
  IT: "Tigerair Taiwan", OZ: "Asiana Airlines", KE: "Korean Air",
  SQ: "Singapore Airlines", CX: "Cathay Pacific", MH: "Malaysia Airlines",
  TG: "Thai Airways", VN: "Vietnam Airlines", GA: "Garuda Indonesia",
  MU: "China Eastern", CA: "Air China",
};

function fmtDuration(minutes) {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${h}h`;
}

/**
 * Fetch cheapest real prices for a route on a given date.
 * Returns standard flight objects — departs/arrives are null (this API
 * only carries price + stops + duration, not timetable).
 */
export async function getFlightPrices({ from, to, date, token }) {
  if (!token) throw new Error("TRAVELPAYOUTS_TOKEN not set");

  const params = new URLSearchParams({
    origin: from,
    destination: to,
    period_type: "day",
    beginning_of_period: date,
    one_way: "true",
    currency: "usd",
    limit: "10",
    show_to_affiliates: "true",
  });

  const res = await fetch(`${BASE}/v2/prices/latest?${params}`, {
    headers: { "X-Access-Token": token },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Travelpayouts ${res.status}: ${body}`);
  }

  const json = await res.json();
  const rows = json.data?.[to];
  if (!rows?.length) return [];

  const [y, m, d] = date.split("-");

  return rows.map((r) => ({
    carrier:     AIRLINE_NAMES[r.airline] ?? r.airline,
    flight:      `${r.airline}${r.flight_number ?? ""}`,
    departs:     null,
    arrives:     null,
    duration:    fmtDuration(r.duration_to ?? r.duration) ?? "?",
    stops:       r.transfers ?? 0,
    price_usd:   r.price,
    layovers:    [],
    // Aviasales booking link with real inventory
    booking_url: `https://www.aviasales.com${r.link ?? `/search/${from}${m}${d}${to}1`}`,
  }));
}

/**
 * Build an Aviasales search URL without any API key.
 * Always works — opens real booking search with live prices.
 */
export function aviasalesUrl(from, to, date, adults = 1) {
  const [, m, d] = date.split("-");
  return `https://www.aviasales.com/search/${from}${m}${d}${to}${adults}`;
}
