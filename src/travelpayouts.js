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

function fmtTimeFromIso(isoStr) {
  if (!isoStr) return null;
  return String(isoStr).slice(11, 16); // "HH:MM"
}

/**
 * v1/prices/calendar — day-by-day prices for a whole month.
 * Returns entries sorted by proximity to target date, with airline codes
 * and departure times when available.
 */
export async function getCalendarPrices({ from, to, date, token }) {
  const [y, m] = date.split("-");
  const monthParam = `${y}-${m}`;

  const url = `${BASE}/v1/prices/calendar?origin=${from}&destination=${to}` +
    `&depart_date=${monthParam}&calendar_type=departure_date` +
    `&currency=usd&one_way=true&token=${token}`;

  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  if (!json.success || !json.data) return [];

  // Flatten nested {origin: {destination: {date: data}}} structure
  const all = [];
  for (const originData of Object.values(json.data)) {
    for (const destData of Object.values(originData)) {
      for (const [dayStr, info] of Object.entries(destData)) {
        all.push({ ...info, depart_date: dayStr });
      }
    }
  }
  if (!all.length) return [];

  // Sort by proximity to target date, then by price
  const target = new Date(date + "T00:00:00Z").getTime();
  all.sort((a, b) => {
    const da = Math.abs(new Date(a.depart_date + "T00:00:00Z").getTime() - target);
    const db = Math.abs(new Date(b.depart_date + "T00:00:00Z").getTime() - target);
    return da - db || a.price - b.price;
  });

  return all.slice(0, 10).map(r => ({
    carrier:     r.airline ?? null,
    flight:      r.airline && r.flight_number ? `${r.airline}${r.flight_number}` : null,
    departs:     fmtTimeFromIso(r.departure_at),
    arrives:     null,
    duration:    fmtDuration(r.duration_to ?? r.duration),
    stops:       r.transfers ?? 0,
    price_usd:   r.price,
    depart_date: r.depart_date,
    layovers:    [],
    booking_url: "https://www.aviasales.com",
  }));
}

/**
 * v1/prices/cheap — cheapest prices per month, indexed by airline.
 * Useful fallback when calendar has no data (route not popular enough).
 */
async function getCheapPrices({ from, to, date, token }) {
  const [y, m] = date.split("-");
  const monthParam = `${y}-${m}`;

  const url = `${BASE}/v1/prices/cheap?origin=${from}&destination=${to}` +
    `&depart_date=${monthParam}&currency=usd&token=${token}`;

  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  if (!json.success || !json.data) return [];

  // data is { DESTINATION: { AIRLINE: { price, transfers, departure_at, ... } } }
  const all = [];
  for (const destData of Object.values(json.data)) {
    for (const [airline, info] of Object.entries(destData)) {
      all.push({ airline, ...info });
    }
  }
  if (!all.length) return [];

  return all.slice(0, 8).map(r => ({
    carrier:     r.airline ?? null,
    flight:      r.airline && r.flight_number ? `${r.airline}${r.flight_number}` : null,
    departs:     fmtTimeFromIso(r.departure_at),
    arrives:     null,
    duration:    fmtDuration(r.duration),
    stops:       r.transfers ?? 0,
    price_usd:   r.price,
    depart_date: date,
    layovers:    [],
    booking_url: "https://www.aviasales.com",
  }));
}

/**
 * Fetch real cached prices for a route.
 * Chain: calendar (day-level, has airline) → cheap (month, by airline) → latest (48h broad)
 */
export async function getFlightPrices({ from, to, date, token }) {
  if (!token) throw new Error("TRAVELPAYOUTS_TOKEN not set");
  const headers = { "X-Access-Token": token };

  // 1. Calendar prices — day-by-day with airline codes (best quality)
  try {
    const cal = await getCalendarPrices({ from, to, date, token });
    if (cal.length >= 2) return cal;
  } catch { /* fall through */ }

  // 2. Cheap prices — month-level per airline (good for obscure routes)
  try {
    const cheap = await getCheapPrices({ from, to, date, token });
    if (cheap.length >= 2) return cheap;
  } catch { /* fall through */ }

  // 3. v2/prices/latest — 48h search cache, month then year fallback
  const [y, m] = date.split("-");
  const monthStart = `${y}-${m}-01`;

  for (const params of [
    new URLSearchParams({ origin: from, destination: to, period_type: "month",
      beginning_of_period: monthStart, one_way: "true", currency: "usd",
      limit: "10", show_to_affiliates: "true", sorting: "price" }),
    new URLSearchParams({ origin: from, destination: to, period_type: "year",
      one_way: "true", currency: "usd", limit: "10",
      show_to_affiliates: "true", sorting: "price" }),
  ]) {
    const res = await fetch(`${BASE}/v2/prices/latest?${params}`, { headers });
    if (!res.ok) continue;
    const json = await res.json();
    const rows = Array.isArray(json.data) ? json.data : Object.values(json.data ?? {});
    if (!rows.length) continue;

    return rows.map((r) => ({
      carrier:     r.airline ?? null,
      flight:      r.airline && r.flight_number ? `${r.airline}${r.flight_number}` : null,
      departs:     null,
      arrives:     null,
      duration:    fmtDuration(r.duration ?? r.duration_to),
      stops:       r.number_of_changes ?? r.transfers ?? 0,
      price_usd:   r.value ?? r.price,
      depart_date: r.depart_date ?? date,
      layovers:    [],
      booking_url: "https://www.aviasales.com",
    }));
  }

  return [];
}

/**
 * Build an Aviasales search URL — always works, no API key needed.
 */
export function aviasalesUrl(from, to, date, adults = 1) {
  const [, m, d] = date.split("-");
  return `https://www.aviasales.com/search/${from}${m}${d}${to}${adults}`;
}
