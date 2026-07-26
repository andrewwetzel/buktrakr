import { describe, expect, it } from "vitest";
import { parseEntries } from "../src/docs";

describe("parseEntries", () => {
  it("parses a current-format entry, skipping the empty cover line", () => {
    const doc =
      "Dune — Frank Herbert\n\nRating: 9/10 · 2026-07-25 · ISBN 9780441172719\n" +
      "The Good\ngreat worldbuilding\nover two lines\nThe Bad\npacing\nThe Other\n—\n";
    expect(parseEntries(doc)).toEqual([
      { title: "Dune", author: "Frank Herbert", rating: 9, date: "2026-07-25" },
    ]);
  });

  it("parses old-format entries and multiple entries", () => {
    const doc =
      "Dune — Frank Herbert\nRating: 9/10 · 2026-07-25\nThe Good\nx\n" +
      "Old Book — Someone Else\nRating: 6/10 · 2025-12-01\nWhat I liked\nold format\n";
    expect(parseEntries(doc)).toHaveLength(2);
    expect(parseEntries(doc)[1]).toEqual({
      title: "Old Book",
      author: "Someone Else",
      rating: 6,
      date: "2025-12-01",
    });
  });

  it("handles a title line without the em-dash separator", () => {
    const doc = "Anonymous Classic\nRating: 7/10 · 2026-01-01\n";
    expect(parseEntries(doc)).toEqual([
      { title: "Anonymous Classic", author: "", rating: 7, date: "2026-01-01" },
    ]);
  });

  it("ignores meta-lookalike lines neutralized with a zero-width space", () => {
    const doc =
      "Real — Author\nRating: 8/10 · 2026-02-02\nThe Good\n​Rating: 1/10 · 2020-01-01\n";
    expect(parseEntries(doc)).toHaveLength(1);
  });

  it("returns [] for empty or entry-free text", () => {
    expect(parseEntries("")).toEqual([]);
    expect(parseEntries("just some prose\nwith lines\n")).toEqual([]);
  });
});
