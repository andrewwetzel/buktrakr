import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  verifySessionToken,
  type SessionData,
} from "../src/session";

const SECRET = "test-secret-0123456789";
const DATA: SessionData = {
  sub: "google-sub-123",
  email: "reader@example.com",
  refreshToken: "1//refresh-token",
  docId: "doc-abc",
  sheetId: null,
  mode: "doc",
  docName: "BukTrakr — Book Reviews",
  style: "classic",
};

describe("session tokens", () => {
  it("round-trips", async () => {
    const token = await createSessionToken(SECRET, DATA, 3600);
    expect(await verifySessionToken(SECRET, token)).toEqual(DATA);
  });

  it("round-trips a null docId", async () => {
    const token = await createSessionToken(
      SECRET,
      { ...DATA, docId: null },
      3600,
    );
    expect((await verifySessionToken(SECRET, token))?.docId).toBeNull();
  });

  it("round-trips sheet-mode settings", async () => {
    const token = await createSessionToken(
      SECRET,
      {
        ...DATA,
        mode: "sheet",
        sheetId: "sheet-1",
        docName: "My Books",
        style: "vintage",
      },
      3600,
    );
    expect(await verifySessionToken(SECRET, token)).toMatchObject({
      mode: "sheet",
      sheetId: "sheet-1",
      docName: "My Books",
      style: "vintage",
    });
  });

  it("fills defaults for legacy cookies missing the settings fields", async () => {
    const legacy = {
      sub: DATA.sub,
      email: DATA.email,
      refreshToken: DATA.refreshToken,
      docId: "old-doc",
    } as SessionData;
    const token = await createSessionToken(SECRET, legacy, 3600);
    expect(await verifySessionToken(SECRET, token)).toMatchObject({
      docId: "old-doc",
      sheetId: null,
      mode: "doc",
      docName: "BukTrakr — Book Reviews",
      style: "classic",
    });
  });

  it("rejects the wrong secret", async () => {
    const token = await createSessionToken(SECRET, DATA, 3600);
    expect(await verifySessionToken("other-secret", token)).toBeNull();
  });

  it("rejects tampered ciphertext", async () => {
    const token = await createSessionToken(SECRET, DATA, 3600);
    const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    expect(await verifySessionToken(SECRET, tampered)).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const token = await createSessionToken(SECRET, DATA, -10);
    expect(await verifySessionToken(SECRET, token)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await verifySessionToken(SECRET, "not-a-token")).toBeNull();
    expect(await verifySessionToken(SECRET, "a.b")).toBeNull();
    expect(await verifySessionToken(SECRET, "")).toBeNull();
  });
});
