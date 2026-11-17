import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openStore, matchPlace, normalizePerson } from "../src/db.js";

let store;
let n = 0;
beforeEach(() => {
  store = openStore(`test-${n++}`);
});
afterEach(async () => {
  await store.close();
});

const canyon = {
  name: "Canyon Coffee",
  lat: 34.0813774,
  lon: -118.2547445,
  osmId: "node/12695459909",
  address: "1559 Echo Park Avenue, Los Angeles",
};

describe("logPerson", () => {
  it("creates the place and the person in one step", async () => {
    const { person, place, createdPlace } = await store.logPerson({
      name: "  Rosa ",
      place: canyon,
      role: "barista",
      spellingUnsure: true,
      date: "2026-11-12",
    });
    expect(createdPlace).toBe(true);
    expect(person.name).toBe("Rosa");
    expect(person.spellingUnsure).toBe(true);
    expect(person.firstMet).toBe("2026-11-12");
    expect(person.lastSeen).toBe("2026-11-12");
    expect(person.visitCount).toBe(1);
    expect(person.placeId).toBe(place.id);
    expect(await store.listPlaces()).toHaveLength(1);
    expect(await store.peopleAt(place.id)).toHaveLength(1);
  });

  it("reuses a saved place matched by OSM id", async () => {
    const a = await store.logPerson({ name: "Rosa", place: canyon });
    const b = await store.logPerson({
      name: "Sam",
      place: { ...canyon, name: "Canyon Coffee Echo Park" },
    });
    expect(b.createdPlace).toBe(false);
    expect(b.place.id).toBe(a.place.id);
    expect(await store.listPlaces()).toHaveLength(1);
  });

  it("reuses a hand-typed place by name, ignoring case and accents", async () => {
    const a = await store.logPerson({
      name: "Rosa",
      place: { name: "Café Luna" },
    });
    const b = await store.logPerson({
      name: "Ola",
      place: { name: "cafe luna" },
    });
    expect(b.place.id).toBe(a.place.id);
  });

  it("gives a hand-typed place coordinates the first time location is available", async () => {
    const a = await store.logPerson({
      name: "Rosa",
      place: { name: "Canyon Coffee" },
    });
    expect(a.place.lat).toBeNull();
    await store.logPerson({
      name: "Sam",
      place: { name: "Canyon Coffee", lat: 34.08, lon: -118.25 },
    });
    const saved = await store.getPlace(a.place.id);
    expect(saved.lat).toBe(34.08);
  });

  it("keeps same-named places far apart as separate places", async () => {
    await store.logPerson({
      name: "A",
      place: { name: "Starbucks", lat: 34.08, lon: -118.25 },
    });
    const b = await store.logPerson({
      name: "B",
      place: { name: "Starbucks", lat: 34.15, lon: -118.35 },
    });
    expect(b.createdPlace).toBe(true);
    expect(await store.listPlaces()).toHaveLength(2);
  });

  it("rejects a missing name or place", async () => {
    await expect(
      store.logPerson({ name: "  ", place: canyon }),
    ).rejects.toThrow(/name/i);
    await expect(
      store.logPerson({ name: "Rosa", place: { name: "" } }),
    ).rejects.toThrow(/place/i);
    expect(await store.listPeople()).toHaveLength(0);
  });

  it("defaults the date to today", async () => {
    const { person } = await store.logPerson({ name: "Rosa", place: canyon });
    expect(person.firstMet).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("sawAgain", () => {
  it("moves last seen forward and counts the visit", async () => {
    const { person } = await store.logPerson({
      name: "Rosa",
      place: canyon,
      date: "2026-11-12",
    });
    const after = await store.sawAgain(person.id, "2026-11-16");
    expect(after.lastSeen).toBe("2026-11-16");
    expect(after.visitCount).toBe(2);
    expect(after.firstMet).toBe("2026-11-12");
  });

  it("counts two taps on the same day as one visit", async () => {
    const { person } = await store.logPerson({
      name: "Rosa",
      place: canyon,
      date: "2026-11-12",
    });
    await store.sawAgain(person.id, "2026-11-16");
    const again = await store.sawAgain(person.id, "2026-11-16");
    expect(again.visitCount).toBe(2);
  });

  it("ignores a date before the last recorded visit and never moves last seen backward", async () => {
    const { person } = await store.logPerson({
      name: "Rosa",
      place: canyon,
      date: "2026-11-12",
    });
    await store.sawAgain(person.id, "2026-11-16");
    const after = await store.sawAgain(person.id, "2026-11-14");
    expect(after.lastSeen).toBe("2026-11-16");
    expect(after.visitCount).toBe(2);
  });
});

describe("edit and delete", () => {
  it("updates fields and keeps the creation time", async () => {
    const { person } = await store.logPerson({
      name: "Rosa",
      place: canyon,
      spellingUnsure: true,
    });
    const updated = await store.updatePerson(person.id, {
      name: "Roza",
      spellingUnsure: false,
      note: "oat flat white",
    });
    expect(updated.name).toBe("Roza");
    expect(updated.spellingUnsure).toBe(false);
    expect(updated.note).toBe("oat flat white");
    expect(updated.createdAt).toBe(person.createdAt);
  });

  it("deletes a person", async () => {
    const { person } = await store.logPerson({ name: "Rosa", place: canyon });
    await store.deletePerson(person.id);
    expect(await store.getPerson(person.id)).toBeNull();
  });

  it("deleting a place deletes its people and reports how many", async () => {
    const { place } = await store.logPerson({ name: "Rosa", place: canyon });
    await store.logPerson({ name: "Sam", place: canyon });
    const other = await store.logPerson({
      name: "Ola",
      place: { name: "Bar Bandini" },
    });
    expect(await store.deletePlace(place.id)).toBe(2);
    expect(await store.listPeople()).toEqual([other.person]);
  });

  it("renames a place", async () => {
    const { place } = await store.logPerson({ name: "Rosa", place: canyon });
    const renamed = await store.savePlace({
      id: place.id,
      name: "Canyon (Echo Park)",
    });
    expect(renamed.name).toBe("Canyon (Echo Park)");
    expect(renamed.lat).toBe(canyon.lat);
  });
});

describe("export and import", () => {
  it("round-trips through JSON into an empty device", async () => {
    await store.logPerson({
      name: "Rosa",
      place: canyon,
      role: "barista",
      spellingUnsure: true,
      date: "2026-11-12",
    });
    const backup = JSON.parse(JSON.stringify(await store.exportAll()));
    const other = openStore(`test-import-${n++}`);
    const result = await other.importAll(backup);
    expect(result).toMatchObject({
      placesAdded: 1,
      peopleAdded: 1,
      errors: [],
    });
    expect(await other.listPeople()).toEqual(backup.people);
    await other.close();
  });

  it("does not let an older backup overwrite newer edits", async () => {
    const { person } = await store.logPerson({ name: "Rosa", place: canyon });
    const backup = JSON.parse(JSON.stringify(await store.exportAll()));
    await new Promise((r) => setTimeout(r, 5));
    await store.updatePerson(person.id, { name: "Roza" });
    const result = await store.importAll(backup);
    expect(result.peopleUpdated).toBe(0);
    expect((await store.getPerson(person.id)).name).toBe("Roza");
  });

  it("reports bad rows instead of dropping them silently", async () => {
    const result = await store.importAll({
      places: [{ id: "p1", name: "Canyon Coffee" }],
      people: [
        { id: "a", name: "Rosa", placeId: "p1" },
        { id: "b", name: "", placeId: "p1" },
        { id: "c", name: "Ghost", placeId: "missing" },
      ],
    });
    expect(result.peopleAdded).toBe(1);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.join(" ")).toMatch(/Ghost/);
  });

  it("rejects a file that is not a backup", async () => {
    await expect(store.importAll({ hello: 1 })).rejects.toThrow(
      /not a Regular Maxing backup/,
    );
  });
});

describe("matchPlace", () => {
  it("matches by id first", () => {
    const places = [{ id: "x", name: "A" }];
    expect(matchPlace(places, { id: "x", name: "B" })).toBe(places[0]);
  });
});

describe("normalizePerson", () => {
  it("repairs a last-seen date earlier than first met", () => {
    const p = normalizePerson({
      name: "R",
      placeId: "p",
      firstMet: "2026-11-12",
      lastSeen: "2026-01-01",
    });
    expect(p.lastSeen).toBe("2026-11-12");
  });
});

describe("review fixes: import validation", () => {
  it("replaces a non-date updatedAt so sorting and merging keep working", async () => {
    const r = await store.importAll({
      places: [{ id: "p1", name: "Canyon Coffee", updatedAt: "zzz" }],
      people: [
        { id: "a", name: "Rosa", placeId: "p1", updatedAt: 123 },
        { id: "b", name: "Sam", placeId: "p1", updatedAt: { x: 1 } },
      ],
    });
    expect(r.errors).toEqual([]);
    for (const p of await store.listPeople()) {
      expect(typeof p.updatedAt).toBe("string");
      expect(Number.isNaN(Date.parse(p.updatedAt))).toBe(false);
    }
    expect(Date.parse((await store.getPlace("p1")).updatedAt)).not.toBeNaN();
  });

  it("a garbage updatedAt never beats a real edit on a later import", async () => {
    const { person } = await store.logPerson({ name: "Rosa", place: canyon });
    const r = await store.importAll({
      places: [],
      people: [{ ...person, name: "Hijacked", updatedAt: "9999" }],
    });
    expect(r.peopleUpdated).toBe(0);
    expect((await store.getPerson(person.id)).name).toBe("Rosa");
  });

  it("rejects ids that are not short strings", async () => {
    const r = await store.importAll({
      places: [
        { id: 42, name: "Numbered" },
        { id: "x".repeat(500), name: "Long" },
      ],
      people: [],
    });
    expect(r.placesAdded).toBe(0);
    expect(r.errors).toHaveLength(2);
  });
});

describe("review fixes: saw again with a future last-seen date", () => {
  it("does not count a visit when last seen is already on or after the date", async () => {
    const { person } = await store.logPerson({
      name: "Rosa",
      place: canyon,
      date: "2026-11-12",
    });
    await store.updatePerson(person.id, { lastSeen: "2026-11-20" });
    const after = await store.sawAgain(person.id, "2026-11-16");
    expect(after.visitCount).toBe(1);
    expect(after.lastSeen).toBe("2026-11-20");
  });
});

describe("review fixes: CSV-style rows without ids or edit times", () => {
  it("re-importing hand-made rows does not duplicate places or people", async () => {
    let k = 0;
    const rows = () => ({
      places: [
        {
          id: `gen-place-${k++}`,
          name: "Canyon Coffee",
          updatedAt: "1970-01-01T00:00:00.000Z",
        },
      ],
      people: [],
    });
    const first = rows();
    first.people.push({
      id: `gen-${k++}`,
      name: "Rosa",
      placeId: first.places[0].id,
      generatedId: true,
    });
    await store.importAll(first);
    const second = rows();
    second.people.push({
      id: `gen-${k++}`,
      name: "rosa",
      placeId: second.places[0].id,
      generatedId: true,
    });
    const r = await store.importAll(second);
    expect(r.placesAdded).toBe(0);
    expect(r.peopleAdded).toBe(0);
    expect(await store.listPlaces()).toHaveLength(1);
    expect(await store.listPeople()).toHaveLength(1);
  });

  it("a row with an id but no edit time does not overwrite newer edits", async () => {
    const { person } = await store.logPerson({ name: "Rosa", place: canyon });
    const r = await store.importAll({
      places: [],
      people: [{ id: person.id, name: "Old Name", placeId: person.placeId }],
    });
    expect(r.peopleUpdated).toBe(0);
    expect((await store.getPerson(person.id)).name).toBe("Rosa");
  });
});
