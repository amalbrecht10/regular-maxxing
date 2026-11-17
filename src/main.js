import "./style.css";
import { openStore } from "./db.js";
import { toCSV, fromCSV } from "./backup.js";
import { groupByPlace, filterGroups, ORPHAN_PLACE_ID } from "./search.js";
import {
  fetchNearbyVenues,
  placesByDistance,
  nearestPlace,
  formatDistance,
  hasCoords,
  distanceMeters,
  roundCoord,
} from "./geo.js";
import { esc, relativeDate, formatDate, todayISO, uuid, fold } from "./util.js";

// ---------- constants ----------

// Within this distance of a saved place, the Here view says "You're at".
const HERE_METERS = 150;
// In the log form, the closest suggestion is pre-selected only if it is this close.
const AUTOSELECT_METERS = 100;
// Saved places within this distance are offered first in the log form.
const SAVED_NEARBY_METERS = 300;
// How many new (not yet saved) venues from OpenStreetMap the log form offers.
const NEARBY_VENUES_SHOWN = 5;
// A location fix younger than this is reused instead of asking the GPS again.
const FIX_MAX_AGE_MS = 60_000;
const ROLES = [
  "Barista",
  "Server",
  "Bartender",
  "Manager",
  "Host",
  "Cook",
  "Owner",
  "Cashier",
];

const store = openStore();
const view = document.getElementById("view");
const titleEl = document.getElementById("title");
const backEl = document.getElementById("back");
const backLabel = document.getElementById("back-label");
const sheetRoot = document.getElementById("sheet-root");
const toastEl = document.getElementById("toast");

const state = {
  here: null, // { lat, lon, accuracy, at }
  location: "idle", // idle | locating | ok | denied | unavailable
  query: "",
  map: null,
  renderToken: 0,
  backupData: null,
};

// ---------- seed (local machine only) ----------

// __LOCAL_SEED__ is filled in by vite.config.js: the contents of the git-ignored seed.local.json
// for `npm run dev` or LOCAL_SEED=1 builds on Alexander's machine, and null everywhere else,
// including the public GitHub Pages build. It is imported once into an empty database.
async function applySeedOnce() {
  const seed = __LOCAL_SEED__;
  if (!seed || (await store.getMeta("seeded"))) return;
  const [places, people] = await Promise.all([
    store.listPlaces(),
    store.listPeople(),
  ]);
  if (places.length === 0 && people.length === 0) await store.importAll(seed);
  await store.setMeta("seeded", true);
}

// ---------- small render helpers ----------

function setChrome({ title, tab, back = null }) {
  titleEl.textContent = title;
  document.title =
    title === "Regular Maxing" ? title : `${title} · Regular Maxing`;
  for (const a of document.querySelectorAll(".tabbar a")) {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (back) {
    backEl.hidden = false;
    backEl.href = back.href;
    backLabel.textContent = back.label;
  } else backEl.hidden = true;
}

function personMeta(p) {
  const parts = [];
  if (p.role) parts.push(esc(p.role));
  parts.push(`seen ${esc(relativeDate(p.lastSeen))}`);
  if (p.visitCount > 1) parts.push(`${p.visitCount} visits`);
  return parts.join(" · ");
}

function personRow(p, { placeName = "" } = {}) {
  const unsure = p.spellingUnsure ? `<span class="badge">spelling?</span>` : "";
  const where = placeName
    ? `<span class="person-meta">${esc(placeName)}</span>`
    : "";
  const note = p.note ? `<span class="person-note">${esc(p.note)}</span>` : "";
  const seenToday = p.lastSeen >= todayISO();
  return `<li class="person">
    <a class="person-main" href="#/person/${encodeURIComponent(p.id)}">
      <span class="person-name">${esc(p.name)}${unsure}</span>
      ${where}
      <span class="person-meta">${personMeta(p)}</span>
      ${note}
    </a>
    <button type="button" class="btn btn-saw" data-action="saw" data-id="${esc(p.id)}"
      aria-label="Saw ${esc(p.name)} again today"${seenToday ? ' aria-pressed="true"' : ""}>${seenToday ? "Seen ✓" : "Saw again"}</button>
  </li>`;
}

let toastTimer;
function toast(message, action) {
  clearTimeout(toastTimer);
  toastEl.replaceChildren();
  const text = document.createElement("span");
  text.textContent = message;
  toastEl.append(text);
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = action.label;
    btn.addEventListener("click", async () => {
      toastEl.hidden = true;
      await action.run();
    });
    toastEl.append(btn);
  }
  toastEl.hidden = false;
  toastTimer = setTimeout(() => (toastEl.hidden = true), action ? 6000 : 3000);
}

async function loadAll() {
  const [places, people] = await Promise.all([
    store.listPlaces(),
    store.listPeople(),
  ]);
  return { places, people };
}

// ---------- location ----------

function locate({ force = false } = {}) {
  if (!("geolocation" in navigator)) {
    state.location = "unavailable";
    return Promise.resolve(null);
  }
  if (!force && state.here && Date.now() - state.here.at < FIX_MAX_AGE_MS)
    return Promise.resolve(state.here);
  state.location = "locating";
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.here = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          at: Date.now(),
        };
        state.location = "ok";
        resolve(state.here);
      },
      (err) => {
        // Forget any older fix: using it would rank and pre-select places you have already left.
        state.here = null;
        state.location =
          err.code === err.PERMISSION_DENIED ? "denied" : "unavailable";
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
    );
  });
}

// Returns "granted", "denied", "prompt", or "unknown" without ever showing a prompt.
async function locationPermission() {
  try {
    const status = await navigator.permissions?.query({ name: "geolocation" });
    return status?.state ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function refreshHereIfAllowed() {
  if ((await locationPermission()) !== "granted") return;
  if (state.here && Date.now() - state.here.at < FIX_MAX_AGE_MS) return;
  const onHere = currentRoute().name === "here";
  if (onHere) render();
  await locate({ force: true });
  if (currentRoute().name === "here") render();
}

// ---------- views ----------

async function renderHere(token) {
  setChrome({ title: "Regular Maxing", tab: "here" });
  const { places, people } = await loadAll();
  if (token !== state.renderToken) return;

  if (people.length === 0) {
    view.innerHTML = `<div class="empty">
      <h2>No regulars yet</h2>
      <p>When someone tells you their name, tap + and save it. It takes a few seconds.</p>
      <button type="button" class="btn btn-primary btn-big" data-action="add">Log a name</button>
    </div>`;
    return;
  }

  let hereHtml = "";
  let hereIds = new Set(); // people already shown in the "You're at" card
  if (state.here) {
    const near = nearestPlace(places, state.here);
    if (near) {
      const atPlace = near.distance <= HERE_METERS;
      const list = people
        .filter((p) => p.placeId === near.place.id)
        .sort(
          (a, b) =>
            b.lastSeen.localeCompare(a.lastSeen) ||
            a.name.localeCompare(b.name),
        );
      hereIds = new Set(list.map((p) => p.id));
      hereHtml = `<section class="card here" aria-label="People where you are">
        <div class="here-head">
          <div class="here-kicker">${atPlace ? "You're at" : `Nearest saved place · ${esc(formatDistance(near.distance))} away`}</div>
          <a class="here-place" href="#/place/${encodeURIComponent(near.place.id)}">${esc(near.place.name)}</a>
        </div>
        ${list.length ? `<ul class="people">${list.map((p) => personRow(p)).join("")}</ul>` : `<p class="prompt-card muted">No one saved here yet.</p>`}
      </section>`;
    } else {
      hereHtml = `<section class="card prompt-card"><p class="muted">None of your saved places has a location yet. Places get one when you log a name there with location on.</p></section>`;
    }
  } else if (state.location === "locating") {
    hereHtml = `<section class="card prompt-card"><div class="status-line"><span class="spinner"></span>Finding where you are…</div></section>`;
  } else if (state.location === "denied") {
    hereHtml = `<section class="card prompt-card"><p class="muted small">Location is off for this app, so it can't tell where you are. You can still search in Places. To turn it on: Settings › Privacy &amp; Security › Location Services.</p></section>`;
  } else {
    hereHtml = `<section class="card prompt-card">
      <p>See who works at the place you're standing in.</p>
      <button type="button" class="btn btn-primary btn-block" data-action="locate">Use my location</button>
      ${state.location === "unavailable" ? `<p class="error">Couldn't get a location fix. Try again in a moment.</p>` : ""}
    </section>`;
  }

  const placeById = new Map(places.map((p) => [p.id, p]));
  const recent = people
    .filter((p) => !hereIds.has(p.id))
    .sort(
      (a, b) =>
        b.lastSeen.localeCompare(a.lastSeen) ||
        b.updatedAt.localeCompare(a.updatedAt),
    )
    .slice(0, 8);
  const recentHtml = recent.length
    ? `<h2 class="section-title">${hereIds.size ? "Recently seen elsewhere" : "Recently seen"}</h2>
    <section class="card"><ul class="people">${recent.map((p) => personRow(p, { placeName: placeById.get(p.placeId)?.name ?? "No place" })).join("")}</ul></section>`
    : "";
  view.innerHTML = hereHtml + recentHtml;
}

function placesListHtml(groups, query) {
  if (!groups.length) {
    return query
      ? `<div class="empty"><p>Nothing matches “${esc(query)}”.</p></div>`
      : `<div class="empty"><h2>No places yet</h2><p>Places appear here after you log your first name.</p></div>`;
  }
  return groups
    .map(({ place, people, lastSeen }) => {
      const head =
        place.id === ORPHAN_PLACE_ID
          ? `<div class="place-head"><span class="place-name">No place</span><span class="place-sub">fix these</span></div>`
          : `<a class="place-head" href="#/place/${encodeURIComponent(place.id)}">
              <span class="place-name">${esc(place.name)}</span>
              <span class="place-sub">${lastSeen ? `last ${esc(relativeDate(lastSeen))}` : "no one yet"}</span>
            </a>`;
      const list = people.length
        ? `<ul class="people">${people.map((p) => personRow(p)).join("")}</ul>`
        : "";
      return `<section class="card">${head}${list}</section>`;
    })
    .join("");
}

async function renderPlaces(token) {
  setChrome({ title: "Places", tab: "places" });
  const { places, people } = await loadAll();
  if (token !== state.renderToken) return;
  const groups = groupByPlace(places, people);
  view.innerHTML = `<div class="search">
      <input type="search" id="search" placeholder="Search names, places, notes" value="${esc(state.query)}"
        aria-label="Search names, places and notes" autocomplete="off" autocorrect="off" enterkeyhint="search" />
    </div>
    <div id="place-list">${placesListHtml(filterGroups(groups, state.query), state.query)}</div>`;
  const input = view.querySelector("#search");
  const list = view.querySelector("#place-list");
  input.addEventListener("input", () => {
    state.query = input.value;
    list.innerHTML = placesListHtml(
      filterGroups(groups, state.query),
      state.query,
    );
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur(); // hide the keyboard so results are visible
  });
}

async function renderPlace(token, id) {
  if (!id) return renderMissing("That place");
  const [place, people] = await Promise.all([
    store.getPlace(id),
    store.peopleAt(id),
  ]);
  if (token !== state.renderToken) return;
  if (!place) return renderMissing("That place");
  setChrome({
    title: place.name,
    tab: "places",
    back: { href: "#/places", label: "Places" },
  });
  people.sort(
    (a, b) =>
      b.lastSeen.localeCompare(a.lastSeen) || a.name.localeCompare(b.name),
  );
  const dist =
    state.here && hasCoords(place)
      ? ` · ${formatDistance(distanceMeters(state.here, place))} away`
      : "";
  view.innerHTML = `<div class="detail-head">
      <p class="muted small">${esc(place.address || (hasCoords(place) ? "" : "No location saved"))}${esc(dist)}</p>
    </div>
    <section class="card">${people.length ? `<ul class="people">${people.map((p) => personRow(p)).join("")}</ul>` : `<p class="prompt-card muted">No one saved here.</p>`}</section>
    <div class="btn-row"><button type="button" class="btn btn-primary btn-big" data-action="add" data-place="${esc(place.id)}">Log someone here</button></div>
    <h2 class="section-title">Edit place</h2>
    <form class="card form-card" id="place-form">
      <label class="field"><span>Name</span><input name="name" value="${esc(place.name)}" required autocomplete="off" /></label>
      <label class="field"><span>Address <em>optional</em></span><input name="address" value="${esc(place.address)}" autocomplete="off" /></label>
      <button type="submit" class="btn btn-block">Save place</button>
      <p class="error" role="alert"></p>
    </form>
    <div class="btn-row"><button type="button" class="btn btn-danger" data-action="delete-place" data-id="${esc(place.id)}">Delete place</button></div>`;
  const form = view.querySelector("#place-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await store.savePlace({
        id: place.id,
        name: form.name.value,
        address: form.address.value,
      });
      toast("Place saved");
      render();
    } catch (err) {
      form.querySelector(".error").textContent = err.message;
    }
  });
}

async function renderPerson(token, id) {
  if (!id) return renderMissing("That person");
  const [person, places] = await Promise.all([
    store.getPerson(id),
    store.listPlaces(),
  ]);
  if (token !== state.renderToken) return;
  if (!person) return renderMissing("That person");
  const place = places.find((p) => p.id === person.placeId);
  setChrome({
    title: person.name,
    tab: "places",
    back: place
      ? { href: `#/place/${encodeURIComponent(place.id)}`, label: place.name }
      : { href: "#/places", label: "Places" },
  });
  const sorted = [...places].sort((a, b) => a.name.localeCompare(b.name));
  const options = sorted
    .map(
      (p) =>
        `<option value="${esc(p.id)}"${p.id === person.placeId ? " selected" : ""}>${esc(p.name)}</option>`,
    )
    .join("");
  const seenToday = person.lastSeen >= todayISO();
  view.innerHTML = `<div class="stats">
      <div class="stat"><b>${person.visitCount}</b><span>${person.visitCount === 1 ? "visit" : "visits"}</span></div>
      <div class="stat"><b>${esc(relativeDate(person.lastSeen))}</b><span>last seen</span></div>
      <div class="stat"><b>${esc(formatDate(person.firstMet).replace(/, \d{4}$/, ""))}</b><span>first met</span></div>
    </div>
    <button type="button" class="btn btn-primary btn-block btn-big" data-action="saw" data-id="${esc(person.id)}">${seenToday ? "Seen today ✓" : "Saw them again today"}</button>
    <h2 class="section-title">Details</h2>
    <form class="card form-card" id="person-form">
      <label class="field"><span>Name</span><input class="name-input" name="name" value="${esc(person.name)}" required autocomplete="off" autocapitalize="words" autocorrect="off" spellcheck="false" /></label>
      <label class="check"><input type="checkbox" name="unsure"${person.spellingUnsure ? " checked" : ""} /> Not sure of the spelling</label>
      <label class="field"><span>Place</span><select name="placeId">${person.placeId && !place ? `<option value="" selected>Choose a place</option>` : ""}${options}</select></label>
      <label class="field"><span>Role <em>optional</em></span><input name="role" value="${esc(person.role)}" list="roles" autocomplete="off" autocapitalize="words" /></label>
      <label class="field"><span>Note <em>optional</em></span><textarea name="note" rows="3">${esc(person.note)}</textarea></label>
      <div class="row-2">
        <label class="field"><span>First met</span><input type="date" name="firstMet" value="${esc(person.firstMet)}" max="${todayISO()}" required /></label>
        <label class="field"><span>Last seen</span><input type="date" name="lastSeen" value="${esc(person.lastSeen)}" max="${todayISO()}" required /></label>
      </div>
      <label class="field"><span>Visits</span><input type="number" name="visitCount" value="${person.visitCount}" min="1" inputmode="numeric" /></label>
      <button type="submit" class="btn btn-primary btn-block">Save changes</button>
      <p class="error" role="alert"></p>
    </form>
    ${rolesDatalist()}
    <div class="btn-row"><button type="button" class="btn btn-danger" data-action="delete-person" data-id="${esc(person.id)}">Delete ${esc(person.name)}</button></div>`;
  const form = view.querySelector("#person-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = form.querySelector(".error");
    if (!form.placeId.value) {
      err.textContent = "Choose a place.";
      return;
    }
    try {
      await store.updatePerson(person.id, {
        name: form.name.value,
        spellingUnsure: form.unsure.checked,
        placeId: form.placeId.value,
        role: form.role.value,
        note: form.note.value,
        firstMet: form.firstMet.value,
        lastSeen: form.lastSeen.value,
        visitCount: form.visitCount.value,
      });
      toast("Saved");
      render();
    } catch (e2) {
      err.textContent = e2.message;
    }
  });
}

function rolesDatalist() {
  return `<datalist id="roles">${ROLES.map((r) => `<option value="${r}"></option>`).join("")}</datalist>`;
}

async function renderMap(token) {
  setChrome({ title: "Map", tab: "map" });
  document.body.classList.add("is-map");
  view.innerHTML = `<div class="map" id="map" role="application" aria-label="Map of your places"></div>`;
  const [{ default: L }, { places, people }] = await Promise.all([
    import("./leaflet.js"),
    loadAll(),
  ]);
  if (token !== state.renderToken) return;

  const map = L.map("map", { zoomControl: false, attributionControl: true });
  state.map = map;
  L.control.zoom({ position: "topright" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    // Send only the site origin as the referrer, which the OSM tile policy asks for.
    referrerPolicy: "strict-origin-when-cross-origin",
  }).addTo(map);

  const byPlace = new Map();
  for (const p of people) {
    if (!byPlace.has(p.placeId)) byPlace.set(p.placeId, []);
    byPlace.get(p.placeId).push(p);
  }
  const located = places.filter(hasCoords);
  const bounds = [];
  for (const place of located) {
    const list = (byPlace.get(place.id) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const icon = L.divIcon({
      className: "",
      html: `<div class="pin"><span>${list.length}</span></div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 40],
      popupAnchor: [0, -38],
    });
    const popup = `<a class="popup-place" href="#/place/${encodeURIComponent(place.id)}">${esc(place.name)}</a>
      <ul class="popup-people">${list.map((p) => `<li><a href="#/person/${encodeURIComponent(p.id)}">${esc(p.name)}${p.spellingUnsure ? " (?)" : ""}${p.role ? ` · <span style="font-weight:400">${esc(p.role)}</span>` : ""}</a></li>`).join("") || "<li>No one yet</li>"}</ul>`;
    L.marker([place.lat, place.lon], {
      icon,
      title: place.name,
      alt: place.name,
    })
      .addTo(map)
      .bindPopup(popup);
    bounds.push([place.lat, place.lon]);
  }
  if (state.here) {
    L.circleMarker([state.here.lat, state.here.lon], {
      radius: 8,
      color: "#fff",
      weight: 3,
      fillColor: "#2f7de1",
      fillOpacity: 1,
    }).addTo(map);
  }
  if (bounds.length) map.fitBounds(bounds, { padding: [48, 48], maxZoom: 16 });
  else if (state.here) map.setView([state.here.lat, state.here.lon], 15);
  else map.setView([34.0736, -118.2606], 13); // Echo Park, until there is something to show

  const missing = places.length - located.length;
  if (missing > 0 || !places.length) {
    const note = document.createElement("div");
    note.className = "map-note muted";
    note.textContent = places.length
      ? `${missing} ${missing === 1 ? "place has" : "places have"} no location yet, so ${missing === 1 ? "it isn't" : "they aren't"} on the map.`
      : "Your places will appear here once you log a name.";
    view.append(note);
  }
}

async function renderBackup(token) {
  setChrome({ title: "Backup", tab: "backup" });
  const data = await store.exportAll();
  if (token !== state.renderToken) return;
  // Keep the export ready so the Share button can build the file without awaiting,
  // because iOS only allows the share sheet straight from a tap.
  state.backupData = data;
  let persisted = null;
  try {
    persisted = await navigator.storage?.persisted?.();
  } catch {
    /* not supported */
  }
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    navigator.standalone === true;
  view.innerHTML = `<p class="muted small" style="margin:8px 4px 12px">${data.people.length} ${data.people.length === 1 ? "person" : "people"} at ${data.places.length} ${data.places.length === 1 ? "place" : "places"}, stored only on this ${standalone ? "home-screen app" : "browser"}.</p>
    <section class="card prose">
      <p><b>Export</b>. JSON is the full backup. CSV opens in Numbers or Excel.</p>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" data-action="export-json">Export JSON</button>
        <button type="button" class="btn" data-action="export-csv">Export CSV</button>
      </div>
    </section>
    <section class="card prose">
      <p><b>Import</b>. Adds what's missing and takes newer edits. It never deletes anything.</p>
      <label class="btn btn-block file-btn">Choose a .json or .csv file
        <input type="file" id="import-file" accept=".json,.csv,application/json,text/csv" />
      </label>
      <div id="import-result" role="status"></div>
    </section>
    <h2 class="section-title">Privacy</h2>
    <section class="card prose small">
      <ul>
        <li>Everything stays on this phone, in this app's storage. No account, no server, no analytics.</li>
        <li>The only network requests are map tiles from OpenStreetMap and the nearby-places lookup (Overpass). Both receive only map coordinates; the lookup rounds yours to about 11 m.</li>
        <li>${standalone ? "Installed apps keep their storage." : "Add this app to your Home Screen. Safari can clear website data that goes unused for a week; home-screen apps are exempt."}${persisted === true ? " Storage is marked persistent." : ""}</li>
        <li>Safari and the home-screen app keep separate data. Use Export and Import to move between them.</li>
      </ul>
    </section>
    <h2 class="section-title">Danger zone</h2>
    <div class="btn-row"><button type="button" class="btn btn-danger" data-action="delete-all">Delete all data</button></div>
    <p class="muted small" style="margin:16px 4px">Regular Maxing · build ${esc(__BUILD_TIME__.slice(0, 16).replace("T", " "))} UTC</p>`;

  view.querySelector("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    const out = view.querySelector("#import-result");
    if (!file) return;
    try {
      const text = await file.text();
      const isCsv = /\.csv$/i.test(file.name) || /^﻿?[a-z_]+,/i.test(text);
      const payload = isCsv ? fromCSV(text, uuid) : JSON.parse(text);
      const r = await store.importAll(payload);
      const parts = [
        `Added ${r.peopleAdded} ${r.peopleAdded === 1 ? "person" : "people"} and ${r.placesAdded} ${r.placesAdded === 1 ? "place" : "places"}.`,
        r.peopleUpdated + r.placesUpdated
          ? `Updated ${r.peopleUpdated + r.placesUpdated} with newer edits.`
          : "",
        r.skipped ? `Kept ${r.skipped} that were already up to date.` : "",
      ].filter(Boolean);
      const errs = r.errors.length
        ? `<p style="margin:8px 0 0"><b>${r.errors.length} skipped because of problems:</b></p><ul>${r.errors.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
        : "";
      out.innerHTML = `<div class="result">${esc(parts.join(" "))}${errs}</div>`;
      state.backupData = await store.exportAll();
    } catch (err) {
      out.innerHTML = `<div class="result error">Import failed: ${esc(err instanceof SyntaxError ? "this is not valid JSON." : err.message)}</div>`;
    } finally {
      e.target.value = "";
    }
  });
}

function renderMissing(what) {
  setChrome({
    title: "Not found",
    tab: "places",
    back: { href: "#/places", label: "Places" },
  });
  view.innerHTML = `<div class="empty"><h2>${esc(what)} is gone</h2><p>It may have been deleted.</p></div>`;
}

// ---------- quick log sheet ----------

// Built synchronously inside the tap handler so iOS lets the name field take focus
// and raise the keyboard right away.
function openAddSheet({ placeId = null } = {}) {
  if (sheetRoot.firstChild) return;
  const sheet = {
    options: [], // place suggestions: { key, name, lat, lon, osmId, address, id, distance, saved }
    selectedKey: null,
    closed: false,
    places: [],
    recentPlaces: [], // saved places, most recently visited first
  };
  sheetRoot.innerHTML = `<form class="sheet" id="add-form" novalidate aria-labelledby="add-title">
    <div class="sheet-head">
      <button type="button" class="link-btn" data-action="close-sheet">Cancel</button>
      <h2 id="add-title">Log a name</h2>
      <button type="submit" class="link-btn strong">Save</button>
    </div>
    <div class="sheet-body">
      <label class="field"><span>Name</span>
        <input class="name-input" name="name" required autocomplete="off" autocapitalize="words" autocorrect="off" spellcheck="false" enterkeyhint="done" />
      </label>
      <label class="check"><input type="checkbox" name="unsure" /> Not sure of the spelling</label>
      <fieldset class="field"><legend>Place</legend>
        <div class="status-line" id="place-status"></div>
        <div class="chips" id="place-chips"></div>
        <input name="place" list="saved-places" placeholder="Or type the place" autocomplete="off" autocapitalize="words" enterkeyhint="done" aria-label="Place name" />
        <datalist id="saved-places"></datalist>
      </fieldset>
      <label class="field"><span>Role <em>optional</em></span><input name="role" list="roles" placeholder="Barista, server…" autocomplete="off" autocapitalize="words" enterkeyhint="done" /></label>
      <label class="field"><span>Note <em>optional</em></span><textarea name="note" rows="2" placeholder="Their usual, something they mentioned"></textarea></label>
      <div class="date-row"><span>Met on</span><input type="date" name="date" value="${todayISO()}" max="${todayISO()}" aria-label="Date met" /></div>
      <button type="submit" class="btn btn-primary btn-block btn-big">Save</button>
      <p class="error" id="add-error" role="alert"></p>
    </div>
    ${rolesDatalist()}
  </form>`;
  const form = sheetRoot.querySelector("#add-form");
  const status = form.querySelector("#place-status");
  const chips = form.querySelector("#place-chips");
  const placeInput = form.place;
  const errorEl = form.querySelector("#add-error");
  form.name.focus();
  document.body.style.overflow = "hidden";

  function setStatus(html) {
    status.innerHTML = html;
    status.hidden = !html;
  }

  function drawChips() {
    chips.innerHTML = sheet.options
      .map((o) => {
        const meta = [
          o.saved ? `<span class="chip-saved">saved</span>` : "",
          // GPS is rarely better than ~20 m indoors, so anything closer just reads "here".
          Number.isFinite(o.distance)
            ? o.distance < 25
              ? "here"
              : esc(formatDistance(o.distance))
            : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return `<button type="button" class="chip" data-key="${esc(o.key)}" aria-pressed="${o.key === sheet.selectedKey}">
          <span class="chip-name">${esc(o.name)}</span><span class="chip-meta">${meta}</span></button>`;
      })
      .join("");
  }

  function select(key) {
    sheet.selectedKey = key;
    const o = sheet.options.find((x) => x.key === key);
    placeInput.value = o ? o.name : "";
    errorEl.textContent = "";
    drawChips();
  }

  chips.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    select(sheet.selectedKey === chip.dataset.key ? null : chip.dataset.key);
  });
  placeInput.addEventListener("input", () => {
    const o = sheet.options.find((x) => x.key === sheet.selectedKey);
    if (o && placeInput.value !== o.name) {
      sheet.selectedKey = null;
      drawChips();
    }
  });

  function buildOptions(venues) {
    const here = state.here;
    // With location: saved places close by. Without it: the places you visited most recently,
    // because regulars mostly log at the same few places.
    const saved = here
      ? placesByDistance(sheet.places, here)
          .filter((x) => x.distance <= SAVED_NEARBY_METERS)
          .slice(0, 3)
          .map(({ place, distance }) => ({ ...place, distance }))
      : sheet.recentPlaces.slice(0, 3);
    const forced = placeId ? sheet.places.find((p) => p.id === placeId) : null;
    const savedOpts = [forced, ...saved.filter((p) => p.id !== placeId)]
      .filter(Boolean)
      .map((p) => ({
        key: "saved:" + p.id,
        id: p.id,
        name: p.name,
        lat: p.lat,
        lon: p.lon,
        osmId: p.osmId,
        address: p.address,
        distance: here && hasCoords(p) ? distanceMeters(here, p) : NaN,
        saved: true,
      }));
    const savedOsm = new Set(sheet.places.map((p) => p.osmId).filter(Boolean));
    const savedNames = new Set(savedOpts.map((o) => fold(o.name)));
    const venueOpts = venues
      .filter((v) => !savedOsm.has(v.osmId) && !savedNames.has(fold(v.name)))
      .slice(0, NEARBY_VENUES_SHOWN)
      .map((v) => ({ ...v, key: "osm:" + v.osmId, saved: false }));
    // If a nearby venue is already saved (same OSM id) but beyond the saved radius, show it as saved.
    const venueSaved = venues
      .filter((v) => savedOsm.has(v.osmId))
      .map((v) => sheet.places.find((p) => p.osmId === v.osmId))
      .filter((p) => p && !savedOpts.some((o) => o.id === p.id))
      .map((p) => ({
        key: "saved:" + p.id,
        id: p.id,
        name: p.name,
        lat: p.lat,
        lon: p.lon,
        osmId: p.osmId,
        address: p.address,
        distance: distanceMeters(here, p),
        saved: true,
      }));
    const opts = [...savedOpts, ...venueSaved, ...venueOpts].sort((a, b) => {
      if (a.key === "saved:" + placeId) return -1;
      if (b.key === "saved:" + placeId) return 1;
      return (a.distance || 0) - (b.distance || 0);
    });
    sheet.options = opts;
    if (!sheet.options.some((o) => o.key === sheet.selectedKey))
      sheet.selectedKey = null;
    if (!sheet.selectedKey && !placeInput.value) {
      if (forced) select("saved:" + forced.id);
      else if (opts[0] && opts[0].distance <= AUTOSELECT_METERS)
        select(opts[0].key);
      else drawChips();
    } else drawChips();
  }

  // Load saved places, then location, then nearby venues. Each step redraws the chips.
  (async () => {
    const { places, people } = await loadAll();
    sheet.places = places;
    const lastVisit = new Map();
    for (const p of people) {
      if ((lastVisit.get(p.placeId) ?? "") < p.lastSeen)
        lastVisit.set(p.placeId, p.lastSeen);
    }
    sheet.recentPlaces = places
      .filter((p) => lastVisit.has(p.id))
      .sort((a, b) => lastVisit.get(b.id).localeCompare(lastVisit.get(a.id)));
    form.querySelector("#saved-places").innerHTML = sheet.places
      .map((p) => `<option value="${esc(p.name)}"></option>`)
      .join("");
    if (sheet.closed) return;
    if (placeId) {
      buildOptions([]);
      return; // logging at a known place: no need to look anything up
    }
    setStatus(`<span class="spinner"></span>Finding nearby places…`);
    const here = await locate();
    if (sheet.closed) return;
    if (!here) {
      setStatus(
        state.location === "denied"
          ? "Location is off. Type the place below."
          : "Couldn't get your location. Type the place below.",
      );
      buildOptions([]);
      return;
    }
    buildOptions([]);
    try {
      // The cache is per ~100 m cell, so distances stored with it may come from an earlier fix.
      // Recompute them from where you are now before ranking or pre-selecting anything.
      const venues = (await nearbyVenuesCached(here))
        .map((v) => ({ ...v, distance: distanceMeters(here, v) }))
        .sort((a, b) => a.distance - b.distance);
      if (sheet.closed) return;
      setStatus(
        sheet.options.length || venues.length
          ? ""
          : "No cafés, restaurants or bars found nearby. Type the place below.",
      );
      buildOptions(venues);
    } catch {
      if (sheet.closed) return;
      setStatus("Nearby lookup failed. Type the place below.");
    }
  })();

  let saving = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (saving) return; // a second tap or Enter while the first save is running
    errorEl.textContent = "";
    const name = form.name.value.trim();
    const typed = placeInput.value.trim();
    if (!name) {
      errorEl.textContent = "Add a name.";
      form.name.focus();
      return;
    }
    const chosen = sheet.options.find((o) => o.key === sheet.selectedKey);
    let place = null;
    if (chosen)
      place = chosen.saved
        ? { id: chosen.id, name: chosen.name }
        : {
            name: chosen.name,
            lat: chosen.lat,
            lon: chosen.lon,
            osmId: chosen.osmId,
            address: chosen.address,
          };
    else if (typed) {
      // A hand-typed place takes your current coordinates, so it can show up in Here and on the map.
      place = { name: typed };
      if (state.here)
        Object.assign(place, { lat: state.here.lat, lon: state.here.lon });
    }
    if (!place) {
      errorEl.textContent = "Pick or type a place.";
      placeInput.focus();
      return;
    }
    saving = true;
    try {
      // The form is novalidate (so our own messages show), which means the date's max is not
      // enforced by the browser. A future "met on" date would break visit counting, so clamp it.
      const today = todayISO();
      const result = await store.logPerson({
        name,
        place,
        role: form.role.value,
        note: form.note.value,
        spellingUnsure: form.unsure.checked,
        date: form.date.value > today ? today : form.date.value,
      });
      closeSheet();
      requestPersistence();
      toast(`Saved ${result.person.name} at ${result.place.name}`, {
        label: "Undo",
        run: async () => {
          await store.deletePerson(result.person.id);
          if (result.createdPlace) await store.deletePlace(result.place.id);
          toast("Removed");
          render();
        },
      });
      render();
    } catch (err) {
      saving = false;
      errorEl.textContent = err.message;
    }
  });

  sheet.close = () => {
    sheet.closed = true;
  };
  sheetRoot._sheet = sheet;
}

function closeSheet() {
  sheetRoot._sheet?.close();
  sheetRoot._sheet = null;
  sheetRoot.replaceChildren();
  document.body.style.overflow = "";
}

const venueCache = new Map();
async function nearbyVenuesCached(here) {
  // About 100 m cells: standing still and reopening the form reuses the last answer.
  const key = `${roundCoord(here.lat).toFixed(3)},${roundCoord(here.lon).toFixed(3)}`;
  if (!venueCache.has(key)) {
    // Fetch a few extra: venues already saved are shown as saved places, and we still want
    // NEARBY_VENUES_SHOWN new ones to pick from.
    const p = fetchNearbyVenues(here, { limit: NEARBY_VENUES_SHOWN + 3 });
    venueCache.set(key, p);
    p.catch(() => venueCache.delete(key));
  }
  return venueCache.get(key);
}

let persistenceAsked = false;
function requestPersistence() {
  if (persistenceAsked) return;
  persistenceAsked = true;
  navigator.storage?.persist?.().catch(() => {});
}

// ---------- actions (event delegation) ----------

async function handleAction(btn) {
  const { action, id } = btn.dataset;
  if (action === "add")
    return openAddSheet({ placeId: btn.dataset.place || null });
  if (action === "close-sheet") return closeSheet();
  if (action === "locate") {
    const p = locate({ force: true });
    render();
    await p;
    return render();
  }
  if (action === "saw") {
    const before = await store.getPerson(id);
    if (!before) return;
    if (before.lastSeen >= todayISO()) {
      toast(`${before.name} is already marked for today`);
      return;
    }
    const after = await store.sawAgain(id);
    toast(`Saw ${after.name} again, visit ${after.visitCount}`, {
      label: "Undo",
      run: async () => {
        await store.updatePerson(id, {
          lastSeen: before.lastSeen,
          visitCount: before.visitCount,
        });
        render();
      },
    });
    return render();
  }
  if (action === "delete-person") {
    const p = await store.getPerson(id);
    if (!p || !confirm(`Delete ${p.name}? This can't be undone.`)) return;
    await store.deletePerson(id);
    toast(`Deleted ${p.name}`);
    location.hash = `#/place/${encodeURIComponent(p.placeId)}`;
    return;
  }
  if (action === "delete-place") {
    const [pl, people] = await Promise.all([
      store.getPlace(id),
      store.peopleAt(id),
    ]);
    if (!pl) return;
    const msg = people.length
      ? `Delete ${pl.name} and the ${people.length} ${people.length === 1 ? "person" : "people"} saved there? This can't be undone.`
      : `Delete ${pl.name}?`;
    if (!confirm(msg)) return;
    await store.deletePlace(id);
    toast(`Deleted ${pl.name}`);
    location.hash = "#/places";
    return;
  }
  if (action === "export-json" || action === "export-csv")
    return exportFile(action === "export-csv" ? "csv" : "json");
  if (action === "delete-all") {
    const { people } = state.backupData ?? { people: [] };
    if (
      !confirm(
        `Delete all ${people.length} people and their places from this device? Export a backup first if you might want them back.`,
      )
    )
      return;
    await store.clearAll();
    toast("All data deleted");
    return render();
  }
}

function exportFile(kind) {
  const data = state.backupData;
  if (!data) return;
  const stamp = todayISO();
  const file =
    kind === "csv"
      ? new File(
          [toCSV(data.places, data.people)],
          `regular-maxing-${stamp}.csv`,
          { type: "text/csv" },
        )
      : new File(
          [JSON.stringify(data, null, 2)],
          `regular-maxing-${stamp}.json`,
          { type: "application/json" },
        );
  // On iPhone the share sheet is the way to "Save to Files" or AirDrop; elsewhere, download.
  if (navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file], title: file.name }).catch((err) => {
      if (err?.name !== "AbortError") download(file);
    });
  } else download(file);
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  e.preventDefault();
  handleAction(btn).catch((err) =>
    toast(err.message || "Something went wrong"),
  );
});

document.getElementById("add-btn").addEventListener("click", (e) => {
  e.preventDefault();
  const m = currentRoute();
  openAddSheet({ placeId: m.name === "place" ? m.id : null });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && sheetRoot.firstChild) closeSheet();
});

// ---------- router ----------

function currentRoute() {
  const m = location.hash.match(/^#\/?([a-z]*)\/?(.*)$/) || [];
  const name = m[1] || "here";
  let id = null;
  try {
    id = m[2] ? decodeURIComponent(m[2]) : null;
  } catch {
    id = null; // a malformed link such as #/person/%E0%A4 shows "not found" instead of a blank app
  }
  return { name, id };
}

function render() {
  const token = ++state.renderToken;
  const { name, id } = currentRoute();
  if (state.map) {
    state.map.remove();
    state.map = null;
  }
  document.body.classList.remove("is-map");
  const views = {
    here: () => renderHere(token),
    places: () => renderPlaces(token),
    place: () => renderPlace(token, id),
    person: () => renderPerson(token, id),
    map: () => renderMap(token),
    backup: () => renderBackup(token),
  };
  const run = views[name] ?? views.here;
  return run().catch((err) => {
    console.error(err);
    view.innerHTML = `<div class="empty"><h2>Something went wrong</h2><p>${esc(err.message)}</p></div>`;
  });
}

let lastRoute = "";
let updateReady = false;
window.addEventListener("hashchange", () => {
  if (updateReady && !sheetRoot.firstChild) {
    location.reload(); // a newer version took over; switching tabs is a safe moment to load it
    return;
  }
  closeSheet();
  const r = location.hash;
  if (r !== lastRoute) window.scrollTo(0, 0);
  lastRoute = r;
  render();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshHereIfAllowed();
});

// ---------- start ----------

(async () => {
  try {
    await applySeedOnce();
  } catch (err) {
    console.error("Seed failed", err);
  }
  lastRoute = location.hash;
  await render();
  refreshHereIfAllowed();
})();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  // Only an update replaces an existing controller. On the very first visit there is none,
  // and taking control then needs no reload.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) updateReady = true;
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js")
      .catch((err) => console.warn("Service worker failed", err));
  });
}
