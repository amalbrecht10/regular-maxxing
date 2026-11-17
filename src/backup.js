// Backup formats. JSON is the full-fidelity backup; CSV is one row per person for spreadsheets.

export const CSV_COLUMNS = [
  "person_id",
  "name",
  "spelling_unsure",
  "role",
  "note",
  "first_met",
  "last_seen",
  "visit_count",
  "place_id",
  "place_name",
  "place_address",
  "place_lat",
  "place_lon",
  "place_osm_id",
  "updated_at",
];

// Spreadsheet apps run cells starting with = + - @ as formulas ("CSV injection").
// We prefix those with a single quote on export and strip it again on import.
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(value) {
  let s = value == null ? "" : String(value);
  if (FORMULA_START.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s) || s.startsWith("'"))
    s = '"' + s.replaceAll('"', '""') + '"';
  return s;
}

function uncell(s) {
  return s.length > 1 && s[0] === "'" && FORMULA_START.test(s.slice(1))
    ? s.slice(1)
    : s;
}

export function toCSV(places, people) {
  const placeById = new Map(places.map((p) => [p.id, p]));
  const lines = [CSV_COLUMNS.join(",")];
  for (const person of people) {
    const place = placeById.get(person.placeId) ?? {};
    const row = {
      person_id: person.id,
      name: person.name,
      spelling_unsure: person.spellingUnsure ? "true" : "false",
      role: person.role,
      note: person.note,
      first_met: person.firstMet,
      last_seen: person.lastSeen,
      visit_count: person.visitCount,
      place_id: person.placeId,
      place_name: place.name ?? "",
      place_address: place.address ?? "",
      place_lat: place.lat ?? "",
      place_lon: place.lon ?? "",
      place_osm_id: place.osmId ?? "",
      updated_at: person.updatedAt,
    };
    lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(","));
  }
  // CRLF line endings are what RFC 4180 specifies and what Excel expects.
  return lines.join("\r\n") + "\r\n";
}

// RFC 4180 parser: handles quoted fields, doubled quotes, commas and line breaks inside quotes.
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/^﻿/, ""); // drop a byte-order mark if Excel added one
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (inQuotes) throw new Error("The CSV has an unclosed quote.");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

// Convert CSV text into the same { places, people } shape as a JSON backup.
// Rows without ids (for example rows typed into a spreadsheet) get places grouped by name.
export function fromCSV(text, makeId) {
  const rows = parseCSV(text);
  if (!rows.length) throw new Error("The CSV file is empty.");
  const header = rows[0].map((h) => h.trim().toLowerCase());
  for (const required of ["name", "place_name"]) {
    if (!header.includes(required))
      throw new Error(`The CSV is missing the "${required}" column.`);
  }
  const unknown = header.filter((h) => h && !CSV_COLUMNS.includes(h));
  if (unknown.length)
    throw new Error(
      `The CSV has columns this app does not know: ${unknown.join(", ")}. Expected: ${CSV_COLUMNS.join(", ")}.`,
    );
  const col = (r, name) => {
    const i = header.indexOf(name);
    return i === -1 ? "" : uncell(r[i] ?? "").trim();
  };
  const places = new Map();
  const people = [];
  for (const r of rows.slice(1)) {
    const placeName = col(r, "place_name");
    const placeKey = col(r, "place_id") || "name:" + placeName.toLowerCase();
    if (!places.has(placeKey)) {
      places.set(placeKey, {
        id: col(r, "place_id") || makeId(),
        name: placeName,
        address: col(r, "place_address"),
        lat: col(r, "place_lat"),
        lon: col(r, "place_lon"),
        osmId: col(r, "place_osm_id"),
        // CSV rows carry no edit time for places, so mark them as oldest-possible:
        // a CSV import adds missing places but never overwrites a place already on the phone.
        updatedAt: "1970-01-01T00:00:00.000Z",
      });
    }
    people.push({
      id: col(r, "person_id") || makeId(),
      name: col(r, "name"),
      spellingUnsure: col(r, "spelling_unsure").toLowerCase() === "true",
      role: col(r, "role"),
      note: col(r, "note"),
      firstMet: col(r, "first_met"),
      lastSeen: col(r, "last_seen"),
      visitCount: col(r, "visit_count"),
      placeId: places.get(placeKey).id,
      // No edit time means "oldest possible", so the row never overwrites newer edits on the phone.
      updatedAt: col(r, "updated_at") || "1970-01-01T00:00:00.000Z",
      // Rows typed into a spreadsheet have no id; the importer skips them if the same name is
      // already saved at that place, so importing the same sheet twice adds nobody twice.
      generatedId: !col(r, "person_id"),
    });
  }
  return { places: [...places.values()], people };
}
