import { describe, expect, it } from "vitest";
import { validateSettings } from "../src/index";

describe("validateSettings", () => {
  it("accepts valid doc and sheet settings", () => {
    expect(
      validateSettings({ mode: "doc", docName: "My Books", style: "vintage" }),
    ).toEqual({
      mode: "doc",
      docName: "My Books",
      style: "vintage",
      applyToExisting: false,
    });
    expect(
      validateSettings({ mode: "sheet", docName: "Log", style: "classic" }),
    ).toMatchObject({ mode: "sheet" });
    for (const style of ["ocean", "sunset", "royal", "typewriter", "rose"]) {
      expect(
        validateSettings({ mode: "doc", docName: "x", style }),
      ).toMatchObject({ style });
    }
  });

  it("defaults applyToExisting to false and accepts true", () => {
    const base = { mode: "doc", docName: "x", style: "classic" };
    expect(validateSettings(base)!.applyToExisting).toBe(false);
    expect(
      validateSettings({ ...base, applyToExisting: true })!.applyToExisting,
    ).toBe(true);
    expect(
      validateSettings({ ...base, applyToExisting: "yes" })!.applyToExisting,
    ).toBe(false);
  });

  it("defaults a blank name and collapses whitespace", () => {
    expect(
      validateSettings({ mode: "doc", docName: "   ", style: "classic" })!
        .docName,
    ).toBe("BukTrakr — Book Reviews");
    expect(
      validateSettings({
        mode: "doc",
        docName: "My\n  Books",
        style: "classic",
      })!.docName,
    ).toBe("My Books");
  });

  it("rejects unknown modes, styles, oversized names, and junk", () => {
    expect(
      validateSettings({ mode: "wiki", docName: "x", style: "classic" }),
    ).toBeNull();
    expect(
      validateSettings({ mode: "doc", docName: "x", style: "neon" }),
    ).toBeNull();
    expect(
      validateSettings({
        mode: "doc",
        docName: "x".repeat(129),
        style: "classic",
      }),
    ).toBeNull();
    expect(validateSettings(null)).toBeNull();
    expect(validateSettings("nope")).toBeNull();
  });
});
