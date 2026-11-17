// Drives the built app in WebKit at an iPhone 15 viewport, checks the main flows,
// and saves one screenshot per screen to screenshots/.
//
//   npm run build && npm run screenshots
//
// Location is faked at Canyon Coffee in Echo Park. The Overpass lookup is answered from
// tests/fixtures/overpass-echo-park.json so the run is repeatable and does not load the public
// service. Map tiles are fetched from OpenStreetMap for real (a few dozen tiles per run).
// Extra demo people come from tests/fixtures/demo.json through the app's own Import button.

import { webkit, devices } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

const PORT = 4179;
const BASE = `http://localhost:${PORT}/`;
const OUT = "screenshots";
const CANYON = { latitude: 34.08139, longitude: -118.25476 };
const overpassFixture = readFileSync("tests/fixtures/overpass-echo-park.json", "utf8");
// The seed record (a real person) is read from the git-ignored seed file, so no real name is committed.
if (!existsSync("seed.local.json")) {
  console.error("seed.local.json is missing; the screenshot run needs it.");
  process.exit(1);
}
const SEED_NAME = JSON.parse(readFileSync("seed.local.json", "utf8")).people[0].name;

if (!existsSync("dist/index.html")) {
  console.error("Run `npm run build` first.");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("preview server did not start")), 20000);
  server.stdout.on("data", (d) => {
    if (String(d).includes(String(PORT))) {
      clearTimeout(timer);
      resolve();
    }
  });
  server.on("exit", (code) => reject(new Error(`preview exited ${code}`)));
});

const browser = await webkit.launch();
const checks = [];
function check(name, fn) {
  checks.push(name);
  return fn();
}

async function newContext(opts = {}) {
  const context = await browser.newContext({
    ...devices["iPhone 15"],
    geolocation: CANYON,
    permissions: ["geolocation"],
    colorScheme: "light",
    serviceWorkers: "block", // so route() sees every request; the service worker is checked separately below
    ...opts,
  });
  await context.route("https://overpass-api.de/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: overpassFixture }),
  );
  return context;
}

async function shot(page, name) {
  await page.waitForTimeout(250); // let the sheet and toast animations settle
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("saved", name);
}

try {
  // ---------- main walk-through, light mode, location allowed ----------
  const context = await newContext();
  const page = await context.newPage();
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  page.on("dialog", (d) => d.accept());
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(BASE);
  await page.getByText("You're at").waitFor();
  await check("Here view finds the seed place from location", async () => {
    assert.equal(await page.locator(".here-place").innerText(), "Canyon Coffee");
    assert.ok((await page.locator(".here .person-name").first().innerText()).startsWith(SEED_NAME));
  });
  await shot(page, "01-here");

  // Import fictional demo data through the real Import button.
  await page.goto(BASE + "#/backup");
  await page.locator("#import-file").setInputFiles("tests/fixtures/demo.json");
  await page.locator(".result").waitFor();
  await check("JSON import reports what it added", async () => {
    assert.match(await page.locator(".result").innerText(), /Added 5 people and 4 places/);
  });
  await shot(page, "09-backup");

  // Quick log: + opens the sheet, nearby venues appear, the closest saved place is pre-selected.
  await page.goto(BASE);
  await page.getByText("You're at").waitFor();
  await page.locator("#add-btn").click();
  await page.locator(".chip").nth(3).waitFor();
  await check("log form pre-selects the saved place you are standing in", async () => {
    const pressed = page.locator('.chip[aria-pressed="true"]');
    assert.equal(await pressed.count(), 1);
    assert.match(await pressed.innerText(), /Canyon Coffee/);
    assert.match(await pressed.innerText(), /saved/);
    assert.equal(await page.locator(".chip").count(), 6, "1 saved + 5 nearby venues");
  });
  await check("name field has focus when the form opens", async () => {
    assert.equal(await page.evaluate(() => document.activeElement?.name), "name");
  });
  await page.keyboard.type("Theo");
  await page.locator('input[name="role"]').fill("Barista");
  await shot(page, "02-quick-log");
  // Submit twice in the same instant, as a double tap or Enter-then-tap would.
  await page.evaluate(() => {
    const form = document.getElementById("add-form");
    form.requestSubmit();
    form.requestSubmit();
  });
  await page.locator(".toast").waitFor();
  await check("a double-tapped Save logs the person once", async () => {
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".here .person-name", { hasText: "Theo" }).count(), 1);
  });
  await check("saving shows an Undo toast and the person appears at the place", async () => {
    assert.match(await page.locator(".toast").innerText(), /Saved Theo at Canyon Coffee/);
    await page.locator(".here .person-name", { hasText: "Theo" }).waitFor();
  });
  await shot(page, "03-saved");

  // Saw again on the seed person.
  await page.locator(".here .person", { hasText: SEED_NAME }).locator("[data-action=saw]").click();
  await page.locator(".toast", { hasText: "again, visit 2" }).waitFor();
  await check("saw again counts a visit", async () => {
    assert.match(await page.locator(".here .person", { hasText: SEED_NAME }).innerText(), /2 visits/);
  });

  // Places list and search.
  await page.goto(BASE + "#/places");
  await page.locator(".place-name").first().waitFor();
  await shot(page, "04-places");
  await page.locator("#search").fill("bass");
  await check("search finds a person by their note", async () => {
    assert.equal(await page.locator(".person-name").count(), 1);
    assert.match(await page.locator(".person-name").innerText(), /Dev/);
  });
  await page.locator("#search").fill("taq");
  await check("search finds a place by name", async () => {
    assert.equal(await page.locator(".place-name").innerText(), "Sunset Taqueria");
    assert.equal(await page.locator(".person-name").count(), 2);
  });
  await page.locator("#search").blur();
  await shot(page, "05-search");
  await page.locator("#search").fill("");

  // Place detail.
  await page.locator(".place-head", { hasText: "Canyon Coffee" }).click();
  await page.getByRole("button", { name: "Log someone here" }).waitFor();
  await shot(page, "06-place");

  // Person edit: fix the spelling.
  await page.locator(".person-main", { hasText: SEED_NAME }).click();
  await page.locator("#person-form").waitFor();
  await shot(page, "07-person");
  await page.locator('#person-form input[name="note"], #person-form textarea[name="note"]').fill("Oat cortado. Into ceramics.");
  await page.locator("#person-form button[type=submit]").click();
  await page.locator(".toast", { hasText: "Saved" }).waitFor();
  await check("editing a person saves the note", async () => {
    assert.equal(await page.locator('#person-form textarea[name="note"]').inputValue(), "Oat cortado. Into ceramics.");
  });

  // A malformed link shows "not found" rather than a blank app.
  await page.goto(BASE + "#/person/%E0%A4%A");
  await check("a malformed link shows a not-found page", async () => {
    await page.getByText("is gone").waitFor();
  });

  // Map.
  await page.goto(BASE + "#/map");
  await page.locator(".pin").first().waitFor();
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1200);
  await check("map shows one pin per located place and notes the unlocated one", async () => {
    assert.equal(await page.locator(".pin").count(), 4);
    assert.match(await page.locator(".map-note").innerText(), /1 place has no location/);
  });
  await shot(page, "08-map");
  await page.locator(".leaflet-marker-icon").filter({ has: page.locator(".pin span", { hasText: "2" }) }).first().click();
  await page.locator(".leaflet-popup").waitFor();
  await shot(page, "08b-map-popup");

  // CSV export builds a file (download path, since headless WebKit has no share sheet).
  await page.goto(BASE + "#/backup");
  await page.getByRole("button", { name: "Export CSV" }).waitFor();
  // On a phone, Export opens the share sheet. Headless WebKit claims share support but never
  // resolves the call, so hide the API here to exercise the download fallback instead.
  await page.evaluate(() => Object.defineProperty(Navigator.prototype, "canShare", { value: undefined, configurable: true }));
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
  const csvPath = await download.path();
  await check("CSV export has a header and one row per person", async () => {
    const lines = readFileSync(csvPath, "utf8").trim().split(/\r\n/);
    assert.ok(lines[0].startsWith("person_id,name,spelling_unsure"));
    assert.equal(lines.length, 1 + 7, "header + seed person + Theo + 5 demo people");
  });

  await check("no network calls except the app, Overpass and OSM tiles", async () => {
    const hosts = new Set(requests.map((u) => new URL(u).host));
    hosts.delete(`localhost:${PORT}`);
    for (const h of hosts) assert.ok(h === "overpass-api.de" || h.endsWith("tile.openstreetmap.org"), `unexpected host ${h}`);
  });
  await check("no uncaught page errors", async () => assert.deepEqual(errors, []));

  // Empty state after Delete all.
  await page.getByRole("button", { name: "Delete all data" }).click();
  await page.goto(BASE);
  await page.getByText("No regulars yet").waitFor();
  await shot(page, "10-empty");
  await context.close();

  // ---------- dark mode ----------
  const dark = await newContext({ colorScheme: "dark" });
  const darkPage = await dark.newPage();
  await darkPage.goto(BASE);
  await darkPage.getByText("You're at").waitFor();
  await shot(darkPage, "11-here-dark");
  await darkPage.locator("#add-btn").click();
  await darkPage.locator(".chip").nth(3).waitFor();
  await shot(darkPage, "12-quick-log-dark");
  await dark.close();

  // ---------- location denied: typing the place still works ----------
  const denied = await newContext({ permissions: [], geolocation: undefined });
  const deniedPage = await denied.newPage();
  await deniedPage.goto(BASE);
  await deniedPage.locator(".person-name").first().waitFor();
  await shot(deniedPage, "13-here-no-location");
  await deniedPage.locator("#add-btn").click();
  await deniedPage.locator("#place-status", { hasText: /Type the place/ }).waitFor({ timeout: 15000 });
  await deniedPage.keyboard.type("Jo");
  await deniedPage.locator('input[name="place"]').fill("Bar Bandini");
  await check("with location off, the form offers recently visited saved places", async () => {
    assert.match(await deniedPage.locator(".chip").first().innerText(), /Canyon Coffee/);
    assert.equal(await deniedPage.locator('.chip[aria-pressed="true"]').count(), 0, "nothing pre-selected without location");
  });
  await shot(deniedPage, "14-quick-log-no-location");
  await deniedPage.locator(".sheet-head button[type=submit]").click();
  await deniedPage.locator(".toast", { hasText: "Saved Jo at Bar Bandini" }).waitFor();
  await check("logging works with location off", async () => {});
  await denied.close();

  // ---------- service worker caches the app for offline use ----------
  const swContext = await browser.newContext({ ...devices["iPhone 15"], serviceWorkers: "allow" });
  const swPage = await swContext.newPage();
  await swPage.goto(BASE);
  const cached = await swPage.evaluate(async () => {
    await navigator.serviceWorker.ready;
    const keys = await caches.keys();
    const cache = await caches.open(keys.find((k) => k.startsWith("regular-maxing-")));
    return (await cache.keys()).length;
  });
  await check("service worker precaches the app", async () => assert.ok(cached >= 10, `only ${cached} files cached`));
  await swContext.close();

  console.log(`\n${checks.length} checks passed:\n- ${checks.join("\n- ")}`);
} finally {
  await browser.close();
  server.kill();
}
