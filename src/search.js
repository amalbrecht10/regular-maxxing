import { fold } from "./util.js";

// Most recent "last seen" date among a place's people, or '' if none.
export function lastSeenAt(people) {
  return people.reduce((max, p) => (p.lastSeen > max ? p.lastSeen : max), "");
}

export const ORPHAN_PLACE_ID = "__no_place__";

// Group people under their places, newest activity first.
// A person whose place record is missing (for example after a partial import) is never dropped:
// they go into a visible "No place" group so the user can fix them.
export function groupByPlace(places, people) {
  const byPlace = new Map(places.map((pl) => [pl.id, []]));
  const orphans = [];
  for (const person of people) {
    if (byPlace.has(person.placeId)) byPlace.get(person.placeId).push(person);
    else orphans.push(person);
  }
  const allPlaces = [...places];
  if (orphans.length) {
    allPlaces.push({ id: ORPHAN_PLACE_ID, name: "No place", address: "" });
    byPlace.set(ORPHAN_PLACE_ID, orphans);
  }
  return allPlaces
    .map((place) => {
      const list = byPlace
        .get(place.id)
        .sort(
          (a, b) =>
            (b.lastSeen || "").localeCompare(a.lastSeen || "") ||
            a.name.localeCompare(b.name),
        );
      return { place, people: list, lastSeen: lastSeenAt(list) };
    })
    .sort(
      (a, b) =>
        b.lastSeen.localeCompare(a.lastSeen) ||
        a.place.name.localeCompare(b.place.name),
    );
}

// Search across person names, roles, notes and place names.
// A place-name match keeps all of that place's people; a person match keeps only the matching people.
export function filterGroups(groups, query) {
  const q = fold(query);
  if (!q) return groups;
  const out = [];
  for (const g of groups) {
    const placeHit =
      fold(g.place.name).includes(q) || fold(g.place.address).includes(q);
    const matched = g.people.filter((p) =>
      [p.name, p.role, p.note].some((f) => fold(f).includes(q)),
    );
    if (placeHit) out.push(g);
    else if (matched.length) out.push({ ...g, people: matched });
  }
  return out;
}
