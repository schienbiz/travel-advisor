#!/usr/bin/env node
// Travel Advisor POC — real Tequila flight data → Claude recommendation
//
// Usage:
//   node poc.js                              # default: TPE→NRT June 14 2026
//   node poc.js TPE NRT 2026-06-14 4        # origin dest date nights
//   node poc.js TPE HND 2026-07-01 3 2      # ...with party size
//
// Setup:
//   cp .env.example .env
//   # Add TEQUILA_API_KEY from https://tequila.kiwi.com/portal/register (free)
//   node poc.js

import { config } from "dotenv";
config();

import { execSync } from "child_process";
import { searchFlights } from "./src/tequila.js";
import { generateFlights } from "./src/generate-flights.js";

// --- Parse CLI args ---
const [, , argFrom, argTo, argDate, argNights, argAdults] = process.argv;

const FROM    = argFrom   ?? "TPE";
const TO      = argTo     ?? "NRT";
const DATE    = argDate   ?? "2026-06-14";
const NIGHTS  = parseInt(argNights  ?? "4", 10);
const ADULTS  = parseInt(argAdults  ?? "1", 10);

// Derive return date from departure + nights
const depart = new Date(DATE);
const returnDate = new Date(depart);
returnDate.setDate(returnDate.getDate() + NIGHTS);
const DATES_LABEL = `${depart.toLocaleDateString("en-US", { month: "short", day: "numeric" })}–${returnDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

// --- Fallback flights (used when TEQUILA_API_KEY is not set) ---
const FALLBACK_FLIGHTS = [
  { carrier: "EVA Air",       flight: "BR196",  departs: "09:00", arrives: "13:05", duration: "4h05m", stops: 0, price_usd: 285, booking_url: "https://www.evaair.com" },
  { carrier: "China Airlines", flight: "CI106", departs: "14:00", arrives: "17:55", duration: "3h55m", stops: 0, price_usd: 265, booking_url: "https://www.china-airlines.com" },
  { carrier: "Starlux",       flight: "JX826",  departs: "08:00", arrives: "12:10", duration: "4h10m", stops: 0, price_usd: 310, booking_url: "https://www.starlux-airlines.com" },
];

// --- Hardcoded hotels (Tequila is flights-only; hotels are manual for now) ---
const HOTELS = [
  { name: "Shinjuku Granbell Hotel",        area: "Shinjuku", rating: 4.3, price_per_night_usd: 95,  booking_url: "https://www.booking.com/hotel/jp/shinjuku-granbell.html" },
  { name: "Hotel Gracery Shinjuku",         area: "Shinjuku", rating: 4.5, price_per_night_usd: 115, booking_url: "https://www.booking.com/hotel/jp/gracery-shinjuku.html" },
  { name: "APA Hotel Shinjuku Kabukicho",   area: "Shinjuku", rating: 3.9, price_per_night_usd: 75,  booking_url: "https://www.apahotel.com" },
];

// --- Main ---
console.log(`\n🗺  Travel Advisor`);
console.log(`   ${FROM} → ${TO}  ·  ${DATES_LABEL}  ·  ${NIGHTS} nights  ·  ${ADULTS} traveler${ADULTS > 1 ? "s" : ""}\n`);

// Fetch flights
let flights;
const apiKey = process.env.TEQUILA_API_KEY;

if (apiKey) {
  console.log(`Fetching live flights from Tequila...`);
  try {
    flights = await searchFlights({ from: FROM, to: TO, date: DATE, adults: ADULTS, apiKey });
    if (!flights.length) {
      console.warn(`No flights found for ${FROM}→${TO} on ${DATE}. Falling back to sample data.\n`);
      flights = FALLBACK_FLIGHTS;
    } else {
      console.log(`Found ${flights.length} flight${flights.length > 1 ? "s" : ""}.\n`);
    }
  } catch (err) {
    console.warn(`Tequila API error: ${err.message}\nFalling back to sample data.\n`);
    flights = FALLBACK_FLIGHTS;
  }
} else {
  console.log(`(No TEQUILA_API_KEY — asking Claude to generate realistic flights...)\n`);
  try {
    flights = generateFlights({ from: FROM, to: TO, date: DATE, adults: ADULTS });
    console.log(`Generated ${flights.length} flight${flights.length > 1 ? "s" : ""}.\n`);
  } catch (err) {
    console.warn(`Flight generation failed: ${err.message}\nFalling back to sample data.\n`);
    flights = FALLBACK_FLIGHTS;
  }
}

// Build the prompt
const prompt = `
You are a personal travel advisor. Pick the best flight and hotel. Make a call — no hedging.

Trip: ${FROM} → ${TO}, ${DATES_LABEL}, ${ADULTS} traveler${ADULTS > 1 ? "s" : ""}

FLIGHTS:
${flights.map((f, i) => `[${i}] ${f.carrier} ${f.flight}: departs ${f.departs}, arrives ${f.arrives} (${f.duration}), $${f.price_usd}, ${f.stops === 0 ? "direct" : f.stops + " stop(s)"}`).join("\n")}

HOTELS (${NIGHTS} nights):
${HOTELS.map((h, i) => `[${i}] ${h.name} (${h.area}): $${h.price_per_night_usd}/night, ${h.rating} stars`).join("\n")}

Respond in EXACTLY this format (no other text):
FLIGHT_WINNER: [index]
FLIGHT_RUNNERUP: [index]
FLIGHT_REASON: [one sentence, use real numbers]
HOTEL_WINNER: [index]
HOTEL_RUNNERUP: [index]
HOTEL_REASON: [one sentence, use real numbers]
`.trim();

// Ask Claude
console.log(`Asking Claude...\n`);
let raw;
try {
  raw = execSync(`claude -p ${JSON.stringify(prompt)}`, {
    encoding: "utf8",
    timeout: 30000,
  }).trim();
} catch (err) {
  console.error("claude CLI failed:", err.message);
  process.exit(1);
}

// Parse
function parseField(text, key) {
  const match = text.match(new RegExp(`${key}:\\s*(.+)`));
  return match ? match[1].trim() : null;
}

const fwi = parseInt(parseField(raw, "FLIGHT_WINNER"), 10);
const fri = parseInt(parseField(raw, "FLIGHT_RUNNERUP"), 10);
const fReason = parseField(raw, "FLIGHT_REASON");
const hwi = parseInt(parseField(raw, "HOTEL_WINNER"), 10);
const hri = parseInt(parseField(raw, "HOTEL_RUNNERUP"), 10);
const hReason = parseField(raw, "HOTEL_REASON");

if (isNaN(fwi) || isNaN(hwi) || !fReason || !hReason) {
  console.error("Could not parse Claude response:\n", raw);
  process.exit(1);
}

const fw = flights[fwi];
const fr = flights[Math.min(fri, flights.length - 1)];
const hw = HOTELS[hwi];
const hr = HOTELS[hri];

// Print
console.log("─".repeat(62));
console.log("✈  FLIGHT");
console.log(`   Winner:    ${fw.carrier} ${fw.flight}  ·  $${fw.price_usd}  ·  ${fw.duration}  ·  ${fw.departs}–${fw.arrives}${fw.stops > 0 ? `  ·  ${fw.stops} stop` : ""}`);
console.log(`   Runner-up: ${fr.carrier} ${fr.flight}  ·  $${fr.price_usd}  ·  ${fr.duration}`);
console.log(`   Reason:    ${fReason}`);
console.log(`   Book:      ${fw.booking_url}`);
console.log();
console.log(`🏨  HOTEL  (${NIGHTS} nights = $${hw.price_per_night_usd * NIGHTS} total)`);
console.log(`   Winner:    ${hw.name}  ·  $${hw.price_per_night_usd}/night  ·  ${hw.rating}★`);
console.log(`   Runner-up: ${hr.name}  ·  $${hr.price_per_night_usd}/night  ·  ${hr.rating}★`);
console.log(`   Reason:    ${hReason}`);
console.log(`   Book:      ${hw.booking_url}`);
console.log("─".repeat(62));
