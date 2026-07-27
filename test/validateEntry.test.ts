import { describe, expect, it } from "vitest";
import { validateEntry } from "../src/index";

const base = {
  title: "Dune",
  author: "Frank Herbert",
  rating: 9,
  liked: "sandworms",
  disliked: "",
  notes: "",
};

describe("validateEntry", () => {
  it("accepts a normal entry", () => {
    const e = validateEntry(base)!;
    expect(e.title).toBe("Dune");
    expect(e.rating).toBe(9);
    expect(e.isbn).toBe("");
    expect(e.coverUrl).toBe("");
  });

  it("rejects missing/blank required fields and bad ratings", () => {
    expect(validateEntry({ ...base, title: "  " })).toBeNull();
    expect(validateEntry({ ...base, author: undefined })).toBeNull();
    for (const rating of [0, 11, 7.5, "9", null]) {
      expect(validateEntry({ ...base, rating })).toBeNull();
    }
    expect(validateEntry(null)).toBeNull();
    expect(validateEntry("string")).toBeNull();
  });

  it("collapses newlines and runs of whitespace in title/author", () => {
    const e = validateEntry({
      ...base,
      title: "Line\nOne\n\n  Two",
      author: "A\tB",
    })!;
    expect(e.title).toBe("Line One Two");
    expect(e.author).toBe("A B");
  });

  it("strips non-ISBN characters and caps length", () => {
    expect(validateEntry({ ...base, isbn: "978-0441172719 (pbk)" })!.isbn).toBe(
      "978-0441172719",
    );
    expect(validateEntry({ ...base, isbn: "x".repeat(40) })!.isbn).toBe("");
  });

  it("only allows cover URLs from the book image hosts over https", () => {
    const ok = "https://books.google.com/books/content?id=abc";
    expect(validateEntry({ ...base, coverUrl: ok })!.coverUrl).toBe(ok);
    expect(
      validateEntry({
        ...base,
        coverUrl: "https://covers.openlibrary.org/b/id/1-M.jpg",
      })!.coverUrl,
    ).toContain("openlibrary");
    for (const bad of [
      "https://evil.com/x.png",
      "http://books.google.com/x.png",
      "https://books.google.com.evil.com/x.png",
      "not a url",
    ]) {
      expect(validateEntry({ ...base, coverUrl: bad })!.coverUrl).toBe("");
    }
  });

  it("accepts a valid past date and falls back to today on junk", () => {
    expect(validateEntry({ ...base, date: "2024-03-14" })!.date).toBe(
      "2024-03-14",
    );
    const today = new Date().toISOString().slice(0, 10);
    for (const bad of ["14/03/2024", "yesterday", "1899-01-01", 42]) {
      expect(validateEntry({ ...base, date: bad })!.date).toBe(today);
    }
  });

  it("marks series entries and requires both name and author", () => {
    const e = validateEntry({ ...base, kind: "series", title: "The Expanse" })!;
    expect(e.title).toBe("The Expanse (series)");
    expect(e.author).toBe("Frank Herbert");
    expect(validateEntry({ ...base, kind: "series", title: " " })).toBeNull();
  });

  it("marks author entries, drops title requirement, empties author column", () => {
    const e = validateEntry({
      kind: "author",
      author: "Ursula K. Le Guin",
      rating: 10,
    })!;
    expect(e.title).toBe("Ursula K. Le Guin (author)");
    expect(e.author).toBe("");
    expect(validateEntry({ kind: "author", rating: 10 })).toBeNull();
  });

  it("strips isbn and cover for non-book kinds", () => {
    const e = validateEntry({
      ...base,
      kind: "series",
      isbn: "9780441172719",
      coverUrl: "https://books.google.com/books/content?id=abc",
    })!;
    expect(e.isbn).toBe("");
    expect(e.coverUrl).toBe("");
  });

  it("treats unknown kinds as book", () => {
    expect(validateEntry({ ...base, kind: "movie" })!.title).toBe("Dune");
  });

  it("trims optional bodies and rejects oversized ones", () => {
    expect(validateEntry({ ...base, liked: "  spaced  " })!.liked).toBe(
      "spaced",
    );
    expect(validateEntry({ ...base, notes: "x".repeat(5001) })).toBeNull();
  });
});
