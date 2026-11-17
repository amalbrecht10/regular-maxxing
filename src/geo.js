// Distance math and the OpenStreetMap Overpass lookup for nearby venues.
// The only data sent to Overpass is a rounded latitude and longitude.

export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
export const VENUE_TYPES = [
  "cafe",
  "restaurant",
  "bar",
  "pub",
  "fast_food",
  "ice_cream",
  "biergarten",
  "food_court",
];

// Great-circle distance in meters (haversine formula).
export function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function hasCoords(p) {
  return p != null && Number.isFinite(p.lat) && Number.isFinite(p.lon);
}

export function formatDistance(m) {
  if (!Number.isFinite(m)) return "";
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

// Saved places sorted by distance from `here`; places without coordinates are dropped.
export function placesByDistance(places, here) {
  if (!hasCoords(here)) return [];
  return places
    .filter(hasCoords)
    .map((place) => ({ place, distance: distanceMeters(here, place) }))
    .sort((a, b) => a.distance - b.distance);
}

export function nearestPlace(places, here) {
  return placesByDistance(places, here)[0] ?? null;
}

// Four decimal places is about 11 m. That is plenty to find the café you are standing in,
// and it means the exact GPS fix never leaves the phone.
export function roundCoord(x) {
  return Math.round(x * 1e4) / 1e4;
}

export function buildOverpassQuery(lat, lon, radius) {
  const types = VENUE_TYPES.join("|");
  return `[out:json][timeout:8];nwr(around:${radius},${roundCoord(lat)},${roundCoord(lon)})["amenity"~"^(${types})$"]["name"];out center tags 60;`;
}

function addressFromTags(t = {}) {
  const street = [t["addr:housenumber"], t["addr:street"]]
    .filter(Boolean)
    .join(" ");
  return [street, t["addr:city"]].filter(Boolean).join(", ");
}

// Turn an Overpass JSON response into venues sorted by distance from `here`.
export function parseOverpass(json, here, limit = 5) {
  const seen = new Set();
  const venues = [];
  for (const el of json?.elements ?? []) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    const name = el.tags?.name?.trim();
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const osmId = `${el.type}/${el.id}`;
    if (seen.has(osmId)) continue;
    seen.add(osmId);
    venues.push({
      name,
      lat,
      lon,
      osmId,
      kind: el.tags.amenity ?? "",
      address: addressFromTags(el.tags),
      distance: distanceMeters(here, { lat, lon }),
    });
  }
  venues.sort((a, b) => a.distance - b.distance);
  return venues.slice(0, limit);
}

// Ask Overpass for venues near `here`. Try a tight radius first (fast, small response),
// then widen if fewer than `limit` venues come back. Throws on network or HTTP failure;
// callers fall back to typing the place by hand.
export async function fetchNearbyVenues(
  here,
  { limit = 5, fetchImpl = globalThis.fetch, timeoutMs = 9000 } = {},
) {
  let best = [];
  for (const radius of [200, 600]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(OVERPASS_URL, {
        method: "POST",
        body: new URLSearchParams({
          data: buildOverpassQuery(here.lat, here.lon, radius),
        }),
        signal: controller.signal,
        // Send only the site origin (https://amalbrecht10.github.io/) as the Referer. It names the
        // app, not the user, and overpass-api.de rejects browser requests without one (HTTP 406).
        referrerPolicy: "strict-origin-when-cross-origin",
        credentials: "omit",
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      best = parseOverpass(await res.json(), here, limit);
      if (best.length >= limit) return best;
    } catch (err) {
      // If the tight search already found something, keep it rather than failing the whole lookup.
      if (best.length) return best;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  return best;
}
