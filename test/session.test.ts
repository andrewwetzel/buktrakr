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
