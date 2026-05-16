// Amadeus Flight Offers API (free test tier)
// Sign up: https://developers.amadeus.com → My Apps → Create new app
// Test env base: https://test.api.amadeus.com

const TOKEN_URL  = "https://test.api.amadeus.com/v1/security/oauth2/token";
const SEARCH_URL = "https://test.api.amadeus.com/v2/shopping/flight-offers";

const AIRLINE_NAMES = {
  BR: "EVA Air", CI: "China Airlines", JX: "Starlux Airlines",
  NH: "ANA", JL: "Japan Airlines", MM: "Peach Aviation",
  IT: "Tigerair Taiwan", OZ: "Asiana Airlines", KE: "Korean Air",
  SQ: "Singapore Airlines", CX: "Cathay Pacific", MH: "Malaysia Airlines",
  TG: "Thai Airways", VN: "Vietnam Airlines", GA: "Garuda Indonesia",
  MU: "China Eastern", CA: "Air China", TW: "T'way Air",
  "7C": "Jeju Air", BX: "Air Busan", ZE: "Eastar Jet",
};

const AIRLINE_URLS = {
  BR: "https://www.evaair.com", CI: "https://www.china-airlines.com",
  JX: "https://www.starlux-airlines.com", NH: "https://www.ana.co.jp",
  JL: "https://www.jal.com", MM: "https://www.flypeach.com",
  IT: "https://www.tigerairtw.com", OZ: "https://www.flyasiana.com",
  KE: "https://www.koreanair.com", SQ: "https://www.singaporeair.com",
  CX: "https://www.cathaypacific.com", MH: "https://www.malaysiaairlines.com",
  TG: "https://www.thaiairways.com", VN: "https://www.vietnamairlines.com",
  GA: "https://www.garuda-indonesia.com", MU: "https://www.ceair.com",
  CA: "https://www.airchina.com",
};

// Cache token for its lifetime
let _token = null;
let _tokenExpiry = 0;

async function getToken(clientId, clientSecret) {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) throw new Error(`Amadeus auth failed: ${res.status}`);
  const json = await res.json();
  _token = json.access_token;
  _tokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
  return _token;
}

// PT4H30M → "4h30m"
function parseDuration(iso) {
  const h = parseInt(iso.match(/(\d+)H/)?.[1] ?? 0);
  const m = parseInt(iso.match(/(\d+)M/)?.[1] ?? 0);
  const total = h * 60 + m;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return mm > 0 ? `${hh}h${String(mm).padStart(2, "0")}m` : `${hh}h`;
}

function fmtTime(isoDateTime) {
  return isoDateTime.slice(11, 16);
}

export async function searchFlightsAmadeus({ from, to, date, adults = 1, limit = 5, clientId, clientSecret }) {
  const token = await getToken(clientId, clientSecret);

  const params = new URLSearchParams({
    originLocationCode: from,
    destinationLocationCode: to,
    departureDate: date,
    adults: String(adults),
    max: String(limit),
    currencyCode: "USD",
  });

  const res = await fetch(`${SEARCH_URL}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Amadeus search failed ${res.status}: ${body}`);
  }

  const json = await res.json();
  if (!json.data?.length) return [];

  return json.data.map((offer) => {
    const itinerary = offer.itineraries[0];
    const segments  = itinerary.segments;
    const first     = segments[0];
    const last      = segments[segments.length - 1];
    const carrier   = offer.validatingAirlineCodes?.[0] ?? first.carrierCode;

    return {
      carrier:     AIRLINE_NAMES[carrier] ?? carrier,
      flight:      `${first.carrierCode}${first.number}`,
      departs:     fmtTime(first.departure.at),
      arrives:     fmtTime(last.arrival.at),
      duration:    parseDuration(itinerary.duration),
      stops:       segments.length - 1,
      price_usd:   Math.round(parseFloat(offer.price.total)),
      booking_url: AIRLINE_URLS[carrier] ?? "https://www.google.com/flights",
    };
  });
}
