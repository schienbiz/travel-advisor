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

// POST /api/search
// Body: { from, to, date, nights, adults }
// Returns: { flights, winner, runnerup, reason, datesLabel }
app.post("/api/search", async (req, res) => {
  const { from, to, date, nights = 4, adults = 1 } = req.body;

  if (!from || !to || !date) {
    return res.status(400).json({ error: "from, to, and date are required" });
  }

  const depart = new Date(date);
  const returnDate = new Date(depart);
  returnDate.setDate(returnDate.getDate() + Number(nights));
  const datesLabel = `${depart.toLocaleDateString("en-US", { month: "short", day: "numeric" })}–${returnDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

  // Try Tequila first; fall back to single Claude call that generates + recommends
  if (process.env.TEQUILA_API_KEY) {
    let flights;
    try {
      flights = await searchFlights({ from, to, date, adults, apiKey: process.env.TEQUILA_API_KEY });
    } catch { /* fall through */ }

    if (flights?.length) {
      return res.json(await recommend(flights, { from, to, datesLabel, adults }));
    }
  }

  // Single Claude call: generate flights AND pick the winner in one shot
  const prompt = `You are a personal travel advisor and flight data expert.

Task: Generate 4 realistic one-way flight options from ${from} to ${to} on ${date} for ${adults} adult${adults > 1 ? "s" : ""}, then immediately pick the best one.

Use real airlines that fly this route. Use realistic 2026 times and USD prices. Include a mix: cheapest, fastest, a premium carrier, and optionally one connecting flight.

Respond with ONLY valid JSON — no markdown, no explanation:
{
  "flights": [
    { "carrier": "Airline Name", "flight": "XX000", "departs": "HH:MM", "arrives": "HH:MM", "duration": "XhYYm", "stops": 0, "price_usd": 000, "booking_url": "https://www.airline.com" }
  ],
  "winner_index": 0,
  "runnerup_index": 1,
  "reason": "One sentence with real numbers explaining the pick."
}`.trim();

  let raw;
  try {
    raw = await askClaude(prompt);
  } catch (err) {
    return res.status(500).json({ error: `Claude failed: ${err.message}` });
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return res.status(500).json({ error: "Could not parse Claude response", raw });
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    return res.status(500).json({ error: `JSON parse failed: ${err.message}`, raw: jsonMatch[0] });
  }

  const { flights, winner_index: wi, runnerup_index: ri, reason } = parsed;

  if (!Array.isArray(flights) || !flights.length || isNaN(wi) || !reason) {
    return res.status(500).json({ error: "Unexpected response shape", parsed });
  }

  res.json({
    flights,
    winner: flights[wi],
    runnerup: flights[Math.min(ri, flights.length - 1)],
    reason,
    datesLabel,
  });
});

async function recommend(flights, { from, to, datesLabel, adults }) {
  const prompt = `You are a personal travel advisor. Pick the best flight. Make a call — no hedging.

Trip: ${from} → ${to}, ${datesLabel}, ${adults} traveler${adults > 1 ? "s" : ""}

FLIGHTS:
${flights.map((f, i) => `[${i}] ${f.carrier} ${f.flight}: departs ${f.departs}, arrives ${f.arrives} (${f.duration}), $${f.price_usd}, ${f.stops === 0 ? "direct" : f.stops + " stop(s)"}`).join("\n")}

Respond in EXACTLY this format (no other text):
WINNER: [index]
RUNNERUP: [index]
REASON: [one sentence with real numbers]`.trim();

  const raw = await askClaude(prompt);

  function parseField(text, key) {
    const m = text.match(new RegExp(`${key}:\\s*(.+)`));
    return m ? m[1].trim() : null;
  }

  const wi = parseInt(parseField(raw, "WINNER"), 10);
  const ri = parseInt(parseField(raw, "RUNNERUP"), 10);
  const reason = parseField(raw, "REASON");

  return {
    flights,
    winner: flights[wi],
    runnerup: flights[Math.min(ri, flights.length - 1)],
    reason,
  };
}

const PORT = process.env.PORT || 3004;
app.listen(PORT, () => console.log(`Travel Advisor running at http://localhost:${PORT}`));
