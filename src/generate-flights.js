// Generate realistic flight options for a route using Claude's training knowledge.
// Claude knows Asia-Pacific schedules, airlines, and typical price ranges well.
// Two-call design: this generates options; poc.js recommends from them.
import { execSync } from "child_process";

/**
 * Ask Claude to generate realistic one-way flight options for a route.
 *
 * @param {object} opts
 * @param {string} opts.from    - Origin IATA code (e.g. "TPE")
 * @param {string} opts.to      - Destination IATA code (e.g. "NRT")
 * @param {string} opts.date    - Departure date YYYY-MM-DD
 * @param {number} opts.adults  - Number of passengers
 * @param {number} opts.count   - Number of options to generate (default 4)
 *
 * @returns {Array} Flight objects in standard format
 */
export function generateFlights({ from, to, date, adults = 1, count = 4 }) {
  const prompt = `Generate ${count} realistic one-way flight options from ${from} to ${to} on ${date} for ${adults} adult${adults > 1 ? "s" : ""}.

Use real airlines that actually fly this route. Use realistic departure times, durations, and USD prices typical for this route in 2026.

Respond with ONLY a JSON array, no other text. Each object must have exactly these fields:
[
  {
    "carrier": "Airline Name",
    "flight": "XX000",
    "departs": "HH:MM",
    "arrives": "HH:MM",
    "duration": "XhYYm",
    "stops": 0,
    "price_usd": 000,
    "booking_url": "https://www.airline.com"
  }
]

Include a mix: cheapest option, fastest option, a premium carrier, and optionally one with 1 stop if relevant for this route. Use direct flights where they exist.`;

  let raw;
  try {
    raw = execSync(`/Users/atungc/.local/bin/claude -p ${JSON.stringify(prompt)}`, {
      encoding: "utf8",
      timeout: 60000,
    }).trim();
  } catch (err) {
    throw new Error(`Claude CLI failed: ${err.message}`);
  }

  // Extract JSON array from response (strips any accidental markdown fences)
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) {
    throw new Error(`Could not parse flight JSON from Claude response:\n${raw}`);
  }

  try {
    const flights = JSON.parse(match[0]);
    if (!Array.isArray(flights) || !flights.length) {
      throw new Error("Empty or invalid array");
    }
    return flights;
  } catch (err) {
    throw new Error(`JSON parse failed: ${err.message}\nRaw: ${match[0]}`);
  }
}
