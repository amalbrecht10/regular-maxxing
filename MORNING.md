# Good morning, Alexander

Regular Maxing is built, tested, pushed and deployed. Open it on your phone:

**https://amalbrecht10.github.io/regular-maxxing/**

DEPLOY_STATUS_LINE

## Do this first (3 minutes)

1. Open the link above in **Safari** on your iPhone.
2. Tap Share, then **Add to Home Screen**, then Add. Open **Regulars** from the Home Screen. Use that icon from now on: iOS keeps Safari's data and the Home Screen app's data apart.
3. Tap **+** and log the seed barista from the brief. Tick "Not sure of the spelling", pick or type Canyon Coffee, set "Met on" to Nov 12, and Save. The app starts empty on purpose; decision 1 below explains why.
4. Next time you are at Canyon Coffee, open the app. The name should be at the top under "You're at".

## What works, and how I know

Checked by machine:

- **52 unit tests** for the data layer pass (`npm test`). They cover logging, matching a picked place to a saved one, "saw again" visit counting, deletes, import merge rules, CSV round trips including formula-looking names, search, and the Overpass parser.
- **18 end-to-end checks** pass in WebKit (Safari's engine) at an iPhone 15 viewport (`npm run screenshots`). The run fakes your GPS at Canyon Coffee and fakes the Overpass answer. It covers: the Here screen finding the place, the log form pre-selecting the place you are in, the name field having focus, Undo after saving, a double-tapped Save logging once, saw again, search by note and by place, editing, the map pins and popup, CSV export, import, logging with location off, a malformed link, the service worker caching the app for offline use, no uncaught errors, and no network requests except tiles and Overpass.
- **Screenshots** of every screen, light and dark, are in `screenshots/` in the project folder on your Mac (14 screens plus a map popup). They are git-ignored because they show the seed record.
- **A fresh-context code review** found nine defects; all nine are fixed (DECISIONS.md, entry 20).

Features from the brief, all built: quick log with nearby places from OpenStreetMap, place by hand when location is off or the lookup fails, the "I'm here" view, places list with search across names, places, roles and notes, the Leaflet map with one pin per place, edit and delete, "saw again" with last-seen date and visit count, and JSON and CSV export and import. Dark mode follows the system.

## What I could not verify (needs your phone)

- **The keyboard opening when you tap +.** The name field gets focus in WebKit, but whether iOS raises the keyboard straight away only shows on a device. If it doesn't, logging needs one extra tap on the name field.
- **Location prompts in the Home Screen app.** iOS sometimes asks again for each launch of a home-screen web app, and the app cannot control that. If it nags, roadmap item "native iOS app" is the real fix.
- **The status bar colour** in light and dark mode once installed (DECISIONS.md, entry 18).
- **Export on iPhone** opens the share sheet ("Save to Files"). Headless WebKit cannot show a share sheet, so I tested the download fallback instead.
- **The 10-second target.** I could not time a real log at a counter. Please time one.
- **The real Overpass service from your phone.** Tests use a canned answer. Overpass is free and sometimes slow; I saw one empty response while building. When it fails, the form says so and you type the place.
- **The update reload after a deploy** (DECISIONS.md, entry 7) only shows on a real phone after a second deploy.

## Known limits

- Data lives only on this phone. **Export a backup now and then** (Backup tab, Export JSON, Save to Files).
- A place typed by hand while location is off has no coordinates, so it is not on the map and cannot trigger "You're at" until you log there once with location on.
- No sync between devices. iCloud sync is on the roadmap.

## Decisions that need you

1. **The seed record is not on the public site** (DECISIONS.md, entry 1). Publishing it would put a real person's first name and workplace on a public website and a public repo. I recommend keeping it this way; you add the record by hand in step 3 above.
2. **The repo is public**, because GitHub Pages on a free account needs that. No personal data is in it, and a check (`npm run check:public`) fails the deploy if the seed name or record ever appears. If you would rather keep the code private, that needs GitHub Pro or another host.
3. **The home-screen label is "Regulars"**, because "Regular Maxing" gets cut off under the icon (DECISIONS.md, entry 9). Tell me if you want something else.
4. **Delete the old local branch** when you are happy: `git branch -D local-only-old-history`. It holds my first two commits, which had the seed name in the tests. It was never pushed. My attempt to delete it was blocked, so I renamed it (DECISIONS.md, entry 21).

## Where things are

- `README.md`: running locally, installing on an iPhone, tests, deploy.
- `DECISIONS.md`: 21 entries, each with what, why, and how to change it.
- `docs/ROADMAP.md`: next checks, small v1 ideas, and v2 (native iOS app, iCloud sync, arrival notifications).
- `seed.local.json`: the seed record, on this Mac only.
