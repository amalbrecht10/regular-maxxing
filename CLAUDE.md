# Regular Maxing

Mobile-first PWA for remembering the names of staff at places Alexander visits. Vanilla JS, Vite, IndexedDB, Leaflet. No backend. Deployed to GitHub Pages from `main` by `.github/workflows/deploy.yml`.

## Commands

- Full test suite: `npm test` (Vitest; the summary line reads `Tests  N passed (N)`).
- iPhone end-to-end checks and screenshots: `npm run screenshots` (builds with the local seed, runs WebKit at an iPhone 15 viewport, then rebuilds without the seed and runs `check:public`).
- Dev server: `npm run dev`. Production build: `npm run build`, then `npm run check:public` before any manual deploy.

## Rules for this repo

- Real people's names never go in committed files. The seed record lives in the git-ignored `seed.local.json`. Fixtures in `tests/fixtures/` are fictional apart from public business data (Canyon Coffee's OSM node).
- The app may make network requests only to OpenStreetMap tiles and Overpass. The screenshot run fails on any other host. Do not add fonts, CDNs or analytics.
- Every user-entered value rendered into HTML goes through `esc()` in `src/util.js`.
- Decisions go in `DECISIONS.md`; plans and backlog in `docs/ROADMAP.md`.
