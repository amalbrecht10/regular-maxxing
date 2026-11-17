// On-device storage in IndexedDB. Nothing here touches the network.
//
// Two record types:
//   place:  { id, name, address, lat, lon, osmId, createdAt, updatedAt }
//   person: { id, name, placeId, role, note, spellingUnsure, firstMet, lastSeen,
//             visitCount, createdAt, updatedAt }
// firstMet and lastSeen are local calendar dates (YYYY-MM-DD). createdAt/updatedAt are ISO timestamps.

import { uuid, todayISO, isISODate, fold } from "./util.js";
import { distanceMeters, hasCoords } from "./geo.js";

export const DB_NAME = "regular-maxing";
const DB_VERSION = 1;

// Two places with the same name count as the same place only if they are this close
// (or if either has no coordinates). Two "Starbucks" across town stay separate.
export const SAME_PLACE_METERS = 400;

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Run `work` inside one transaction and resolve when the transaction commits.
// `work` must issue all its requests synchronously; it receives the object stores.
function inTransaction(db, storeNames, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const stores = Object.fromEntries(
      storeNames.map((n) => [n, tx.objectStore(n)]),
    );
    let result;
    try {
      result = work(stores);
    } catch (err) {
      tx.abort();
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
}

export function cleanText(s, max = 500) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanNote(s) {
  // Notes keep line breaks but lose trailing whitespace.
  return String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, 2000);
}

function finiteOrNull(x) {
  const n = typeof x === "string" && x.trim() !== "" ? Number(x) : x;
  return Number.isFinite(n) ? n : null;
}

export const EPOCH = "1970-01-01T00:00:00.000Z";
const MAX_ID_LENGTH = 100;

// Ids come from our own uuid() or from an imported file. They must be short strings,
// because routes and IndexedDB lookups use strings and a number id would be unreachable.
function cleanId(id, what) {
  if (id === undefined || id === null || id === "") return uuid();
  if (typeof id !== "string" || id.length > MAX_ID_LENGTH || id.trim() !== id)
    throw new Error(`${what} id must be a short text value`);
  return id;
}

// A valid edit time as an ISO string, or null. Times more than a day in the future are rejected,
// so a file claiming "9999" cannot win every later merge.
export function validTimestamp(x, nowMs = Date.now()) {
  if (typeof x !== "string") return null;
  const ms = Date.parse(x);
  if (!Number.isFinite(ms) || ms > nowMs + 86400000) return null;
  return new Date(ms).toISOString();
}

export function normalizePlace(input, now = new Date().toISOString()) {
  const name = cleanText(input.name, 120);
  if (!name) throw new Error("A place needs a name.");
  const lat = finiteOrNull(input.lat);
  const lon = finiteOrNull(input.lon);
  const coordsOk =
    lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return {
    id: cleanId(input.id, "Place"),
    name,
    address: cleanText(input.address, 200),
    lat: coordsOk ? lat : null,
    lon: coordsOk ? lon : null,
    osmId: cleanText(input.osmId, 40) || null,
    createdAt: validTimestamp(input.createdAt) ?? now,
    updatedAt: validTimestamp(input.updatedAt) ?? now,
  };
}

export function normalizePerson(input, now = new Date().toISOString()) {
  const name = cleanText(input.name, 80);
  if (!name) throw new Error("A name is required.");
  if (!input.placeId) throw new Error("A person needs a place.");
  if (typeof input.placeId !== "string" || input.placeId.length > MAX_ID_LENGTH)
    throw new Error("Person's place id must be a short text value");
  const firstMet = isISODate(input.firstMet) ? input.firstMet : todayISO();
  const lastSeen = isISODate(input.lastSeen) ? input.lastSeen : firstMet;
  const visits = Number.parseInt(input.visitCount, 10);
  return {
    id: cleanId(input.id, "Person"),
    name,
    placeId: input.placeId,
    role: cleanText(input.role, 60),
    note: cleanNote(input.note),
    spellingUnsure:
      input.spellingUnsure === true || input.spellingUnsure === "true",
    firstMet,
    lastSeen: lastSeen < firstMet ? firstMet : lastSeen,
    visitCount: Number.isFinite(visits) && visits > 0 ? Math.min(visits, 100000) : 1,
    createdAt: validTimestamp(input.createdAt) ?? now,
    updatedAt: validTimestamp(input.updatedAt) ?? now,
  };
}

// Find a saved place that matches a picked or typed place: same OSM id, or same name nearby.
export function matchPlace(places, candidate) {
  if (candidate.id) {
    const byId = places.find((p) => p.id === candidate.id);
    if (byId) return byId;
  }
  if (candidate.osmId) {
    const byOsm = places.find((p) => p.osmId === candidate.osmId);
    if (byOsm) return byOsm;
  }
  const name = fold(candidate.name);
  if (!name) return null;
  const sameName = places.filter((p) => fold(p.name) === name);
  if (!sameName.length) return null;
  if (!hasCoords(candidate)) return sameName[0];
  const close = sameName
    .map((p) => ({
      p,
      d: hasCoords(p) ? distanceMeters(candidate, p) : 0,
    }))
    .filter((x) => x.d <= SAME_PLACE_METERS)
    .sort((a, b) => a.d - b.d);
  return close[0]?.p ?? null;
}

export function openStore(name = DB_NAME, idb = globalThis.indexedDB) {
  let dbPromise;

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = idb.open(name, DB_VERSION);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains("places"))
            d.createObjectStore("places", { keyPath: "id" });
          if (!d.objectStoreNames.contains("people")) {
            const people = d.createObjectStore("people", { keyPath: "id" });
            people.createIndex("placeId", "placeId");
          }
          if (!d.objectStoreNames.contains("meta"))
            d.createObjectStore("meta", { keyPath: "key" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () =>
          reject(new Error("Database is open in another tab."));
      });
    }
    return dbPromise;
  }

  async function getAll(storeName) {
    const d = await db();
    return promisify(
      d.transaction(storeName, "readonly").objectStore(storeName).getAll(),
    );
  }

  async function get(storeName, id) {
    const d = await db();
    const found = await promisify(
      d.transaction(storeName, "readonly").objectStore(storeName).get(id),
    );
    return found ?? null;
  }

  async function put(storeName, record) {
    const d = await db();
    await inTransaction(d, [storeName], "readwrite", (s) =>
      s[storeName].put(record),
    );
    return record;
  }

  const api = {
    listPlaces: () => getAll("places"),
    listPeople: () => getAll("people"),
    getPlace: (id) => get("places", id),
    getPerson: (id) => get("people", id),

    async peopleAt(placeId) {
      const d = await db();
      return promisify(
        d
          .transaction("people", "readonly")
          .objectStore("people")
          .index("placeId")
          .getAll(placeId),
      );
    },

    async getMeta(key) {
      return (await get("meta", key))?.value ?? null;
    },
    async setMeta(key, value) {
      await put("meta", { key, value });
    },

    async savePlace(input) {
      const existing = input.id ? await api.getPlace(input.id) : null;
      const now = new Date().toISOString();
      const place = normalizePlace(
        {
          ...existing,
          ...input,
          createdAt: existing?.createdAt,
          updatedAt: now,
        },
        now,
      );
      return put("places", place);
    },

    // Log a person in one step: reuse the matching saved place or create it, then add the person.
    // Returns { person, place, createdPlace } so the caller can offer Undo.
    async logPerson({ name, place, role, note, spellingUnsure, date }) {
      if (!cleanText(name)) throw new Error("A name is required.");
      if (!place || !cleanText(place.name))
        throw new Error("Pick or type a place.");
      const now = new Date().toISOString();
      const places = await api.listPlaces();
      const match = matchPlace(places, place);
      let savedPlace = match;
      let createdPlace = false;
      if (!match) {
        savedPlace = normalizePlace(place, now);
        createdPlace = true;
      } else if (!hasCoords(match) && hasCoords(place)) {
        // A hand-typed place gains coordinates the first time we log there with location on.
        savedPlace = {
          ...match,
          lat: place.lat,
          lon: place.lon,
          updatedAt: now,
        };
      }
      const day = isISODate(date) ? date : todayISO();
      const person = normalizePerson(
        {
          name,
          placeId: savedPlace.id,
          role,
          note,
          spellingUnsure: Boolean(spellingUnsure),
          firstMet: day,
          lastSeen: day,
          visitCount: 1,
        },
        now,
      );
      const d = await db();
      await inTransaction(d, ["places", "people"], "readwrite", (s) => {
        if (savedPlace !== match) s.places.put(savedPlace);
        s.people.put(person);
      });
      return { person, place: savedPlace, createdPlace };
    },

    async updatePerson(id, patch) {
      const existing = await api.getPerson(id);
      if (!existing) throw new Error("That person no longer exists.");
      const now = new Date().toISOString();
      const person = normalizePerson(
        {
          ...existing,
          ...patch,
          id,
          createdAt: existing.createdAt,
          updatedAt: now,
        },
        now,
      );
      return put("people", person);
    },

    // "Saw them again": bump the visit count and move last-seen to today.
    // Tapping twice on the same day counts once, because a visit is a day, not a tap.
    async sawAgain(id, date = todayISO()) {
      const existing = await api.getPerson(id);
      if (!existing) throw new Error("That person no longer exists.");
      // ">=" rather than "===": if last seen is already today or later (a time-zone change, an
      // imported future date), tapping again must not keep adding visits.
      if (existing.lastSeen >= date) return existing;
      return api.updatePerson(id, {
        lastSeen: date,
        visitCount: existing.visitCount + 1,
      });
    },

    async deletePerson(id) {
      const d = await db();
      await inTransaction(d, ["people"], "readwrite", (s) =>
        s.people.delete(id),
      );
    },

    // Deleting a place deletes its people too; the UI confirms first and says how many.
    async deletePlace(id) {
      const people = await api.peopleAt(id);
      const d = await db();
      await inTransaction(d, ["places", "people"], "readwrite", (s) => {
        for (const p of people) s.people.delete(p.id);
        s.places.delete(id);
      });
      return people.length;
    },

    async exportAll() {
      const [places, people] = await Promise.all([
        api.listPlaces(),
        api.listPeople(),
      ]);
      return {
        app: "regular-maxing",
        schema: 1,
        exportedAt: new Date().toISOString(),
        places,
        people,
      };
    },

    // Merge a backup into this device. Nothing is ever deleted by an import.
    // - Records match by id. An incoming record replaces the stored one only if its updatedAt is
    //   newer. A missing or invalid updatedAt counts as the oldest possible time, so it never
    //   overwrites anything; importing an old backup cannot undo newer edits.
    // - An incoming place with an unknown id that matches a saved place (same OSM id, or same
    //   name nearby) is merged into the saved place, and its people move with it.
    // - A person without an id of their own (a hand-made CSV row; `generatedId: true`) is skipped
    //   if someone with the same name is already saved at that place.
    // Every row that cannot be imported is reported by name in `errors`.
    async importAll(data) {
      if (!data || !Array.isArray(data.places) || !Array.isArray(data.people))
        throw new Error("This file is not a Regular Maxing backup.");
      const errors = [];
      const describe = (raw) => (typeof raw?.name === "string" ? raw.name.slice(0, 80) : "?");
      const asImported = (raw) => ({ ...raw, updatedAt: validTimestamp(raw?.updatedAt) ?? EPOCH });

      const [storedPlaces, storedPeople] = await Promise.all([api.listPlaces(), api.listPeople()]);
      const storedPlaceById = new Map(storedPlaces.map((p) => [p.id, p]));
      const storedPersonById = new Map(storedPeople.map((p) => [p.id, p]));

      const places = [];
      const placeIdMap = new Map(); // incoming place id -> id used on this device
      for (const raw of data.places) {
        try {
          const place = normalizePlace(asImported(raw));
          const match = storedPlaceById.has(place.id) ? null : matchPlace(storedPlaces, { ...place, id: null });
          if (match) placeIdMap.set(place.id, match.id);
          else {
            placeIdMap.set(place.id, place.id);
            places.push(place);
          }
        } catch (e) {
          errors.push(`place "${describe(raw)}": ${e.message}`);
        }
      }
      const knownPlaceIds = new Set([...storedPlaceById.keys(), ...placeIdMap.values()]);

      const people = [];
      let duplicates = 0;
      for (const raw of data.people) {
        try {
          const person = normalizePerson(asImported(raw));
          person.placeId = placeIdMap.get(person.placeId) ?? person.placeId;
          if (!knownPlaceIds.has(person.placeId)) throw new Error("its place is missing from the file");
          if (raw.generatedId === true && !storedPersonById.has(person.id)) {
            const same = storedPeople.find((s) => s.placeId === person.placeId && fold(s.name) === fold(person.name));
            if (same) {
              duplicates++;
              continue;
            }
          }
          people.push(person);
        } catch (e) {
          errors.push(`person "${describe(raw)}": ${e.message}`);
        }
      }

      const counts = {
        placesAdded: 0,
        placesUpdated: 0,
        peopleAdded: 0,
        peopleUpdated: 0,
        skipped: duplicates + (data.places.length - places.length - errors.filter((e) => e.startsWith("place")).length),
      };
      const d = await db();
      await inTransaction(d, ["places", "people"], "readwrite", (s) => {
        for (const p of places) {
          const old = storedPlaceById.get(p.id);
          if (!old) counts.placesAdded++;
          else if (p.updatedAt > old.updatedAt) counts.placesUpdated++;
          else {
            counts.skipped++;
            continue;
          }
          s.places.put(p);
        }
        for (const p of people) {
          const old = storedPersonById.get(p.id);
          if (!old) counts.peopleAdded++;
          else if (p.updatedAt > old.updatedAt) counts.peopleUpdated++;
          else {
            counts.skipped++;
            continue;
          }
          s.people.put(p);
        }
      });
      return { ...counts, errors };
    },

    async clearAll() {
      const d = await db();
      await inTransaction(d, ["places", "people"], "readwrite", (s) => {
        s.places.clear();
        s.people.clear();
      });
    },

    async close() {
      if (dbPromise) (await dbPromise).close();
      dbPromise = null;
    },
  };
  return api;
}
