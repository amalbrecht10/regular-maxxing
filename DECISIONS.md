# Decisions

Choices made while building the first version overnight on 2026-11-16, without stopping to ask. Each entry says what was chosen, why, and what it would take to change. Entries marked **Needs Alexander** are ones I would not have made alone in daytime; they are also listed in MORNING.md.

## Privacy and data

### 1. The seed record stays off the public site and out of the repo. **Needs Alexander**

The brief asked for a seed record: a real barista you met at a real café, by first name. The brief also says the app stores data about real people and everything stays on the device. Putting that record in the code would publish a real person's first name and workplace on a public GitHub repo and a public website. For the same reason, no committed file names the person; tests use fictional names, and the screenshot script reads the name from the ignored seed file.

So the seed lives in `seed.local.json`, which git ignores. It is compiled in only by `npm run dev` or by a build with `LOCAL_SEED=1` (the screenshot run). The public build never has it, and `npm run check:public` fails the deploy if seed content ever appears in `dist/`. I tested the check both ways: a plain build passes, and a seeded build is caught.

What this means for you: on your phone the app starts empty. Adding the seed person by hand takes about ten seconds and is a fair first test of the quick log; tick "Not sure of the spelling" and set "Met on" to Nov 12. If you would rather have the record preloaded on the public site, you would commit the seed file and drop the `check:public` step. I recommend against it.

### 2. Only map tiles and the Overpass lookup touch the network

There are no analytics, no web fonts (system fonts only, since Google Fonts would be a third network call) and no CDN scripts; Leaflet is bundled. The screenshot run asserts this: any request to a host other than the app, `overpass-api.de` or `tile.openstreetmap.org` fails the run.

Two details. First, coordinates sent to Overpass are rounded to 4 decimal places, about 11 m, which is plenty to find the café you are in. Second, the Overpass request uses `referrerPolicy: no-referrer`. The browser still sends an `Origin` header (the site address, not your location) because cross-origin requests always do. Tiles send the site origin as the referrer because the OpenStreetMap tile policy asks apps to identify themselves that way.

### 3. Screenshots are not committed

They show the seed record, so `screenshots/` is git-ignored. They are on this Mac in the project folder.

### 4. Location is never requested on app open

The app asks for location only when you open the log form or tap "Use my location". On open, it checks permission without prompting and only fetches a position if you already said yes. This matches the brief ("never make location required") and avoids a permission prompt as the first thing a new user sees.

## Platform and code

### 5. Vanilla JavaScript with Vite, no framework

The app has six screens and one form. A framework would add more code than the app itself. Vite gives a dev server, a production build with hashed file names, and lazy loading of the map. The main bundle is about 14 KB gzipped; Leaflet (about 44 KB gzipped) loads only when you open the Map tab.

### 6. Packages

Runtime: `leaflet` 1.9.4 only (the brief asked for Leaflet). Development: `vite`, `vitest` (tests), `fake-indexeddb` (lets the IndexedDB tests run in Node), and `@playwright/test` (the iPhone screenshot run). I wrote the IndexedDB wrapper by hand (about 40 lines) instead of adding the `idb` package, so there is one fewer dependency to keep current.

### 7. A hand-written service worker, generated at build time

A small Vite plugin writes `dist/sw.js` with the exact list of built files and a version hash. Every app file is cached on install and served from the cache first, so the app opens instantly with one bar of signal. Map tiles and Overpass are never cached by the service worker. I chose this over `vite-plugin-pwa` (Workbox) because Workbox is large for an app with twelve files.

Trade-off: after a deploy, the phone shows the old version once, installs the new one in the background, and shows the new one next launch.

### 8. Hosting on GitHub Pages from a public repo

This was in the brief. GitHub Pages on a free account requires a public repo. The repo contains no personal data (see decision 1). The workflow in `.github/workflows/deploy.yml` runs the tests, builds, runs the seed check, then publishes.

### 9. Names

The repo is `regular-maxxing`, matching the project folder. The app calls itself "Regular Maxing", as in the brief. Under the home-screen icon it shows **Regulars**, because iOS cuts labels longer than about 12 characters and "Regular Maxing" would show as "Regular Ma…". **Needs Alexander** if you want a different home-screen label: change `short_name` in `public/manifest.webmanifest` and `apple-mobile-web-app-title` in `index.html`.

## Behaviour

### 10. A place is required to save

A person without a place cannot appear in "I'm here" or on the map. With location on, the place you are standing in is usually pre-selected, so this costs nothing. With location off, your three most recently visited places are offered as buttons, and you can type any name.

### 11. Distance thresholds

| Setting                            | Value                                           | Why                                                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "You're at" on the Here screen     | within 150 m of a saved place                   | Indoor GPS error is often 20 to 65 m; 150 m covers that without claiming you are at the café down the block. Beyond 150 m the card says "Nearest saved place, 400 m away". |
| Pre-select a place in the log form | closest option within 100 m                     | Saves a tap when you are clearly inside. Farther than that, nothing is pre-selected, so you cannot save to the wrong place by accident.                                    |
| Offer saved places in the log form | within 300 m                                    |                                                                                                                                                                            |
| Treat two same-named places as one | within 400 m                                    | Two Starbucks across town stay separate; "Canyon Coffee" typed by hand merges with the saved one.                                                                          |
| Overpass search radius             | 200 m, widened to 600 m if fewer than 8 results | Small first query is fast. The form shows the 5 closest venues that are not already saved.                                                                                 |

All are constants at the top of `src/main.js` and `src/db.js`.

### 12. Overpass details

Venue types: cafe, restaurant, bar, pub, fast_food, ice_cream, biergarten, food_court. Only named venues. One endpoint (`overpass-api.de`) with a 9-second timeout; if it fails, the form says so and you type the place. A second mirror would improve reliability but adds another host that receives your coordinates, so it is in the roadmap instead. While building I saw one empty response from `overpass-api.de` before a retry worked, so failures will happen.

### 13. Dates and visits

"Met" and "last seen" are stored as local calendar dates (`2026-11-12`), not timestamps, so a late-night visit never shows up as the next day after a time-zone change. "Saw them again" counts at most one visit per day, because a visit is a day, not a tap. Last seen never moves backward.

### 14. Import merges and never deletes

Records match by id. An incoming record replaces the stored one only if its `updatedAt` is newer, so importing an old backup never overwrites newer edits. Bad rows are listed by name, not silently dropped. CSV import can add places but never overwrites a place already on the phone, because CSV rows carry no edit time for places. A CSV with unknown columns is refused with the list of expected columns.

### 15. CSV formula injection is neutralised

A name like `=HYPERLINK(...)` would run as a formula in Excel or Numbers. On export such cells get a leading `'`; on import it is stripped, so the round trip is exact. A test covers this.

### 16. Undo instead of confirmations for frequent actions

Saving a name and "Saw again" each show an Undo button for six seconds. Deleting a person, a place, or all data asks for confirmation instead, because those are rare and permanent. Deleting a place deletes its people, and the confirmation says how many.

### 17. Export uses the iPhone share sheet

On iPhone, Export opens the share sheet, where "Save to Files" and AirDrop live. Desktop browsers download the file.

### 18. Status bar style "default"

The alternative, `black-translucent`, always draws white status-bar text, which would be invisible on the cream background in light mode. **Needs a device check**: confirm the status bar looks right in both light and dark mode once installed.

### 19. Roadmap location

The roadmap is at `docs/ROADMAP.md`, where Alexander's standing convention keeps it in every project. The brief said `ROADMAP.md`; the content is the same.
