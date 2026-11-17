# Roadmap

## Status (2026-11-16)

Version 1 is a working PWA: quick log with nearby-place suggestions, the Here screen, places list with search, map, edit and delete, "saw them again" with visit counts, and JSON and CSV backup. Data stays on the device. See MORNING.md for what is verified and what still needs a real iPhone.

## Next: things to check or fix after using it for a week

- Test on a real iPhone, installed to the Home Screen: keyboard behaviour in the log form, status bar colours, location prompts in standalone mode, Undo toast placement above the home bar.
- Time a real log at a counter. The target is under 10 seconds from unlocking the phone. If opening the app and tapping + is the slow part, see "Shortcut to log" below.
- Watch how often Overpass fails or is slow. If it is often, add a second Overpass mirror (another host receives rounded coordinates, so this is a privacy trade-off to decide on).
- Decide whether "You're at" should hold for a few minutes after you leave, so the names stay up while you wait for your order outside.

## v1.x ideas (small, still a web app)

- **Shortcut to log.** A home-screen quick action or `#/add` deep link that opens straight into the log form, usable from an iOS Shortcut or the Action button.
- **Pronunciation field.** A short "sounds like" note next to the name, for names you are not sure how to say.
- **Merge duplicates.** When the same person was logged twice, or "Canyon Coffee" and "Canyon Coffee Echo Park" became two places.
- **Move a person to another place** from the person screen with search, not just the place list (staff change jobs).
- **"Not here anymore" flag** so former staff drop out of the Here card but stay searchable.
- **Backup reminder.** A gentle nudge after 20 new names or 30 days since the last export, since data lives only on the phone.
- **Encrypted export.** A passphrase-protected backup file for storing in iCloud Drive.
- **Offline map tiles** for saved places only, if the OSM tile policy allows that scale.

## v2: native and sync

- **Native iOS app (SwiftUI).** Better location (significant-change monitoring), a real widget, and no Safari storage rules. The data model in `src/db.js` maps directly to SwiftData.
- **iCloud sync** through CloudKit's private database, so data stays in the user's own iCloud account and never touches a server we run. Needs conflict rules; the `updatedAt` merge used by Import is a starting point.
- **Arrival notifications.** "You're at your usual café: Maya, Sam" when you walk in. Needs region monitoring, which only a native app can do reliably. Should be opt-in per place, with a daily limit.
- **Lock Screen and Home Screen widget** showing the names at the nearest saved place.
- **Apple Watch glance** with the names at the current place.
- **Siri or Shortcuts intent**: "Log Maya at the corner café".

## Not planned

- Photos of people. The brief rules this out, and it should stay ruled out.
- Accounts, a backend, or analytics.
- Sharing lists with other people. These are notes about real people who did not opt in.
