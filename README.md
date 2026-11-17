# Regular Maxing

A phone app for remembering the names of baristas, servers and staff at the places you go. Log a name in a few seconds at the counter; see it again the next time you walk in.

Live at **https://amalbrecht10.github.io/regular-maxxing/**

- Tap **+**, type the name, and save. The place you are standing in is usually picked for you from OpenStreetMap.
- Open the app at a place you have saved and the names are at the top, under "You're at".
- **Places** lists every place with its people and when you last saw them. Search covers names, places, roles and notes.
- **Map** shows one pin per place. Tap a pin for the names.
- **Saw again** records a visit. Edit or delete anyone from their page.
- **Backup** exports and imports JSON (full backup) and CSV (for spreadsheets).

## Privacy

Everything is stored on your phone in IndexedDB. There is no account, no server and no analytics. The app makes only two kinds of network request: map tiles from OpenStreetMap, and a lookup of nearby cafés, restaurants and bars from the Overpass API. Both receive only map coordinates, and the lookup rounds yours to about 11 m. There are no photos of people.

## Install on an iPhone

1. Open **https://amalbrecht10.github.io/regular-maxxing/** in **Safari**. Other iPhone browsers cannot install web apps in every iOS version.
2. Tap the **Share** button (the square with an arrow), scroll down, and tap **Add to Home Screen**. Keep "Open as Web App" on if iOS shows it, then tap **Add**.
3. Open **Regulars** from your Home Screen. The first time you tap **+**, allow location **While Using the App**.

Two things to know:

- **Use the Home Screen app, not the Safari tab.** iOS keeps their data separate. Safari can also delete a website's data after about a week without use; Home Screen apps are exempt.
- **Back up now and then** (Backup tab, Export JSON, Save to Files). The data lives only on this phone, so a lost phone means lost names unless you have an export.

## Run it locally

Requires Node 20 or newer.

```bash
npm install
```

```bash
npm run dev
```

Open the address Vite prints (http://localhost:5173). Location works on `localhost` without HTTPS.

To try it on your phone before deploying, push to `main` and use the GitHub Pages address. iPhone Safari only allows location on HTTPS, so a plain `http://` address on your local network will load the app but cannot use location.

### Seed data

If a file called `seed.local.json` exists in the project folder, `npm run dev` loads it once into an empty database. The file is git-ignored and never reaches the public site, because it names a real person. Its format is the same as a JSON backup from the Backup tab.

## Tests

```bash
npm test
```

Runs the data-layer tests (Vitest, with `fake-indexeddb`): logging, place matching, "saw again" visit counting, deletes, import merge rules, CSV round trips, search and the Overpass parser.

```bash
npm run screenshots
```

Builds the app, drives it in WebKit (Safari's engine) at an iPhone 15 viewport, checks 16 behaviours end to end, and saves a screenshot of each screen to `screenshots/`. It fakes the GPS position and the Overpass answer (from `tests/fixtures/`); map tiles load for real. It needs `seed.local.json`, and it finishes by rebuilding without the seed and checking that no seed data is in `dist/`. The screenshots are git-ignored because they show the seed record.

The first run needs the WebKit browser:

```bash
npx playwright install webkit
```

## Deploy

Every push to `main` runs `.github/workflows/deploy.yml`, which tests, builds, checks that no seed data is in the build, and publishes `dist/` to GitHub Pages. The app updates itself on the phone the next time it is opened after a deploy (it shows the old version once while the new one downloads).

## Project layout

```
index.html              app shell, iPhone meta tags
src/main.js             screens, quick-log form, router
src/db.js               IndexedDB storage, place matching, import merge
src/backup.js           CSV and JSON formats
src/geo.js              distances and the Overpass lookup
src/search.js           grouping and search
src/sw-template.js      offline service worker (filled in at build time)
public/                 manifest and icons
tests/                  Vitest tests and fictional fixtures
scripts/                screenshot run, icon renderer, seed check
DECISIONS.md            why things are the way they are
docs/ROADMAP.md         what comes next
```
