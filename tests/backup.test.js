import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { toCSV, parseCSV, fromCSV, CSV_COLUMNS } from "../src/backup.js";
import { openStore } from "../src/db.js";

let k = 0;
const makeId = () => `gen-${k++}`;

describe("parseCSV", () => {
  it("handles quotes, doubled quotes, commas and line breaks inside fields", () => {
    const rows = parseCSV('a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n');
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "line1\nline2"],
    ]);
  });

  it("drops a byte-order mark and blank trailing lines", () => {
    expect(parseCSV("﻿a,b\n1,2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("throws on an unclosed quote", () => {
    expect(() => parseCSV('a\n"oops')).toThrow(/unclosed/);
  });
});

describe("toCSV / fromCSV", () => {
  const places = [
    {
      id: "p1",
      name: "Canyon Coffee",
      address: "1559 Echo Park Avenue, Los Angeles",
      lat: 34.0813774,
      lon: -118.2547445,
      osmId: "node/12695459909",
    },
  ];
  const people = [
    {
      id: "r1",
      name: "Rosa",
      placeId: "p1",
      role: "barista",
      note: 'Says "hey friend", likes jazz\nWorks mornings',
      spellingUnsure: true,
      firstMet: "2026-11-12",
      lastSeen: "2026-11-12",
      visitCount: 1,
      updatedAt: "2026-11-12T17:00:00.000Z",
    },
    {
      id: "r2",
      name: '=HYPERLINK("x")',
      placeId: "p1",
      role: "",
      note: "-dash note",
      spellingUnsure: false,
      firstMet: "2026-11-13",
      lastSeen: "2026-11-14",
      visitCount: 2,
      updatedAt: "2026-11-14T17:00:00.000Z",
    },
  ];

  it("writes one header row plus one row per person", () => {
    const csv = toCSV(places, people);
    expect(parseCSV(csv)[0]).toEqual(CSV_COLUMNS);
    expect(parseCSV(csv)).toHaveLength(3);
  });

  it("neutralizes spreadsheet formulas on export", () => {
    const csv = toCSV(places, people);
    expect(csv).not.toMatch(/,=HYPERLINK/);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it("round-trips every field, including formula-looking text", () => {
    const back = fromCSV(toCSV(places, people), makeId);
    expect(back.places).toHaveLength(1);
    expect(back.places[0]).toMatchObject({
      id: "p1",
      name: "Canyon Coffee",
      osmId: "node/12695459909",
    });
    expect(Number(back.places[0].lat)).toBe(34.0813774);
    expect(back.people.map((p) => p.name)).toEqual([
      "Rosa",
      '=HYPERLINK("x")',
    ]);
    expect(back.people[0].note).toBe(people[0].note);
    expect(back.people[1].note).toBe("-dash note");
    expect(back.people[0].spellingUnsure).toBe(true);
  });

  it("imports a hand-made spreadsheet with only name and place columns", async () => {
    const data = fromCSV(
      "name,place_name\nRosa,Canyon Coffee\nSam,Canyon Coffee\nOla,Bar Bandini\n",
      makeId,
    );
    expect(data.places).toHaveLength(2);
    const store = openStore("csv-import");
    const result = await store.importAll(data);
    expect(result).toMatchObject({
      placesAdded: 2,
      peopleAdded: 3,
      errors: [],
    });
    await store.close();
  });

  it("refuses unknown columns instead of ignoring them", () => {
    expect(() => fromCSV("name,place_name,phone\nA,B,555\n", makeId)).toThrow(
      /phone/,
    );
  });

  it("refuses a file without a name column", () => {
    expect(() => fromCSV("who,place_name\nA,B\n", makeId)).toThrow(/"name"/);
  });

  it("re-importing an exported CSV changes nothing", async () => {
    const store = openStore("csv-reimport");
    await store.importAll({ places, people });
    const result = await store.importAll(
      fromCSV(toCSV(places, people), makeId),
    );
    expect(result).toMatchObject({
      placesAdded: 0,
      placesUpdated: 0,
      peopleAdded: 0,
      peopleUpdated: 0,
    });
    await store.close();
  });
});

describe("hand-made CSV imported twice", () => {
  it("adds each person and place once", async () => {
    const sheet = "name,place_name,role\nRosa,Canyon Coffee,barista\nSam,Canyon Coffee,\nOla,Bar Bandini,server\n";
    const store = openStore("csv-twice");
    const first = await store.importAll(fromCSV(sheet, makeId));
    const second = await store.importAll(fromCSV(sheet, makeId));
    expect(first).toMatchObject({ placesAdded: 2, peopleAdded: 3 });
    expect(second).toMatchObject({ placesAdded: 0, peopleAdded: 0, errors: [] });
    expect(await store.listPeople()).toHaveLength(3);
    expect(await store.listPlaces()).toHaveLength(2);
    await store.close();
  });
});
