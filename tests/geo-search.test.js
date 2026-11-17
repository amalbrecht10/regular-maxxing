import { describe, it, expect, vi } from "vitest";
import {
  distanceMeters,
  nearestPlace,
  parseOverpass,
  buildOverpassQuery,
  fetchNearbyVenues,
  formatDistance,
} from "../src/geo.js";
import { groupByPlace, filterGroups, ORPHAN_PLACE_ID } from "../src/search.js";
import { relativeDate, esc, todayISO } from "../src/util.js";

const canyon = { lat: 34.0813774, lon: -118.2547445 };

describe("distance", () => {
  it("is about 111 km per degree of latitude", () => {
    const d = distanceMeters({ lat: 34, lon: -118 }, { lat: 35, lon: -118 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  it("finds the nearest saved place and skips places without coordinates", () => {
    const places = [
      { id: "far", lat: 34.1, lon: -118.3 },
      { id: "none", lat: null, lon: null },
      { id: "near", lat: 34.0814, lon: -118.2548 },
    ];
    expect(nearestPlace(places, canyon).place.id).toBe("near");
    expect(nearestPlace([], canyon)).toBeNull();
  });

  it("formats distances for people, not surveyors", () => {
    expect(formatDistance(43)).toBe("40 m");
    expect(formatDistance(1234)).toBe("1.2 km");
    expect(formatDistance(23456)).toBe("23 km");
  });
});

describe("Overpass", () => {
  it("sends only rounded coordinates", () => {
    const q = buildOverpassQuery(34.0813774, -118.2547445, 200);
    expect(q).toContain("around:200,34.0814,-118.2547");
    expect(q).not.toContain("34.0813774");
  });

  const sample = {
    elements: [
      {
        type: "node",
        id: 1,
        lat: 34.0825,
        lon: -118.256,
        tags: { name: "Far Bar", amenity: "bar" },
      },
      {
        type: "node",
        id: 12695459909,
        lat: 34.0813774,
        lon: -118.2547445,
        tags: {
          name: "Canyon Coffee",
          amenity: "cafe",
          "addr:housenumber": "1559",
          "addr:street": "Echo Park Avenue",
          "addr:city": "Los Angeles",
        },
      },
      {
        type: "way",
        id: 7,
        center: { lat: 34.0816, lon: -118.255 },
        tags: { name: "Taco Spot", amenity: "restaurant" },
      },
      {
        type: "node",
        id: 8,
        lat: 34.0814,
        lon: -118.2548,
        tags: { amenity: "cafe" },
      },
      {
        type: "node",
        id: 1,
        lat: 34.0825,
        lon: -118.256,
        tags: { name: "Far Bar", amenity: "bar" },
      },
    ],
  };

  it("parses venues, sorts by distance, drops unnamed and duplicates", () => {
    const venues = parseOverpass(sample, canyon);
    expect(venues.map((v) => v.name)).toEqual([
      "Canyon Coffee",
      "Taco Spot",
      "Far Bar",
    ]);
    expect(venues[0]).toMatchObject({
      osmId: "node/12695459909",
      kind: "cafe",
      address: "1559 Echo Park Avenue, Los Angeles",
    });
  });

  it("limits to the closest five", () => {
    const many = {
      elements: Array.from({ length: 9 }, (_, i) => ({
        type: "node",
        id: i,
        lat: 34.08 + i * 0.001,
        lon: -118.25,
        tags: { name: `V${i}` },
      })),
    };
    expect(parseOverpass(many, { lat: 34.08, lon: -118.25 })).toHaveLength(5);
  });

  it("widens the radius when the first search finds fewer than five", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => sample,
    }));
    const venues = await fetchNearbyVenues(canyon, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(venues).toHaveLength(3);
    const init = fetchImpl.mock.calls[0][1];
    // overpass-api.de answers 406 to a browser request with no Referer, so send the site origin only.
    expect(init.referrerPolicy).toBe("strict-origin-when-cross-origin");
    expect(init.credentials).toBe("omit");
  });

  it("keeps the first results if the wider search fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => sample })
      .mockResolvedValueOnce({ ok: false, status: 429 });
    expect(await fetchNearbyVenues(canyon, { fetchImpl })).toHaveLength(3);
  });

  it("throws when the service is down so the form can fall back to typing", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 504 }));
    await expect(fetchNearbyVenues(canyon, { fetchImpl })).rejects.toThrow(
      /504/,
    );
  });
});

describe("grouping and search", () => {
  const places = [
    { id: "c", name: "Canyon Coffee", address: "Echo Park Avenue" },
    { id: "b", name: "Bar Bandini", address: "" },
  ];
  const people = [
    {
      id: "1",
      name: "Rosa",
      placeId: "c",
      role: "barista",
      note: "",
      lastSeen: "2026-11-12",
    },
    {
      id: "2",
      name: "Sam",
      placeId: "c",
      role: "manager",
      note: "plays bass",
      lastSeen: "2026-11-15",
    },
    {
      id: "3",
      name: "Renée",
      placeId: "b",
      role: "bartender",
      note: "",
      lastSeen: "2026-11-01",
    },
    {
      id: "4",
      name: "Lost",
      placeId: "gone",
      role: "",
      note: "",
      lastSeen: "2026-10-01",
    },
  ];
  const groups = groupByPlace(places, people);

  it("orders places by most recent visit and people within them", () => {
    expect(groups.map((g) => g.place.id)).toEqual(["c", "b", ORPHAN_PLACE_ID]);
    expect(groups[0].people.map((p) => p.name)).toEqual(["Sam", "Rosa"]);
  });

  it("keeps people whose place is missing in a visible group", () => {
    expect(groups.at(-1).people.map((p) => p.name)).toEqual(["Lost"]);
  });

  it("matches names without accents, roles, notes and places", () => {
    expect(
      filterGroups(groups, "renee").map((g) => g.people.map((p) => p.name)),
    ).toEqual([["Renée"]]);
    expect(filterGroups(groups, "bass")[0].people.map((p) => p.name)).toEqual([
      "Sam",
    ]);
    expect(filterGroups(groups, "canyon")[0].people).toHaveLength(2);
    expect(filterGroups(groups, "echo park")).toHaveLength(1);
    expect(filterGroups(groups, "zzz")).toEqual([]);
    expect(filterGroups(groups, "  ")).toBe(groups);
  });
});

describe("util", () => {
  it("describes dates relative to today", () => {
    expect(relativeDate("2026-11-16", "2026-11-16")).toBe("today");
    expect(relativeDate("2026-11-15", "2026-11-16")).toBe("yesterday");
    expect(relativeDate("2026-11-12", "2026-11-16")).toBe("4 days ago");
    expect(relativeDate("2026-10-20", "2026-11-16")).toBe("3 weeks ago");
    expect(relativeDate("2026-03-04", "2026-11-16")).toBe("Mar 4, 2026");
  });

  it("escapes HTML", () => {
    expect(esc('<img src=x onerror="a">')).toBe(
      "&lt;img src=x onerror=&quot;a&quot;&gt;",
    );
  });

  it("formats today as a local date", () => {
    expect(todayISO(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
