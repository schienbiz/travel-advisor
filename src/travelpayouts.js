// Travelpayouts Flights Data API — real prices from last 48h
// Sign up (free): https://travelpayouts.com → Data API → Get token
// Docs: https://travelpayouts.github.io/slate/

const BASE = "https://api.travelpayouts.com";

function fmtDuration(minutes) {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${h}h`;
}

/**
 * Fetch real cached prices for a route (last 48h user searches).
 * Returns lightweight price anchors — carrier/times filled in later by AI.
 * Falls back to no-filter query if date-specific results are empty.
 */
export async function getFlightPrices({ from, to, date, token }) {
  if (!token) throw new Error("TRAVELPAYOUTS_TOKEN not set");

  const headers = { "X-Access-Token": token };

  // Try date-specific first (period_type=month broadens to the whole month)
  const [y, m] = date.split("-");
  const monthStart = `${y}-${m}-01`;

  for (const params of [
    // Narrow: specific month
    new URLSearchParams({ origin: from, destination: to, period_type: "month",
      beginning_of_period: monthStart, one_way: "true", currency: "usd",
      limit: "10", show_to_affiliates: "true", sorting: "price" }),
    // Broad: any cached price for this route
    new URLSearchParams({ origin: from, destination: to, period_type: "year",
      one_way: "true", currency: "usd", limit: "10",
      show_to_affiliates: "true", sorting: "price" }),
  ]) {
    const res = await fetch(`${BASE}/v2/prices/latest?${params}`, { headers });
    if (!res.ok) continue;
    const json = await res.json();

    // API returns array directly (not nested by destination)
    const rows = Array.isArray(json.data) ? json.data : Object.values(json.data ?? {});
    if (!rows.length) continue;

    return rows.map((r) => ({
      carrier:   r.airline ? (r.airline) : null,   // usually absent
      flight:    r.flight_number ? `${r.airline ?? ""}${r.flight_number}` : null,
      departs:   null,
      arrives:   null,
      duration:  fmtDuration(r.duration ?? r.duration_to),
      stops:     r.number_of_changes ?? r.transfers ?? 0,
      price_usd: r.value ?? r.price,
      gate:      r.gate ?? null,   // booking OTA, not carrier
      depart_date: r.depart_date ?? date,
      layovers:  [],
      booking_url: `https://www.aviasales.com`,
    }));
  }

  return [];
}

/**
 * Build an Aviasales search URL without any API key.
 * Always works — opens real booking search with live prices.
 */
export function aviasalesUrl(from, to, date, adults = 1) {
  const [, m, d] = date.split("-");
  return `https://www.aviasales.com/search/${from}${m}${d}${to}${adults}`;
}
