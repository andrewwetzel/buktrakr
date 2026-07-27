import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import { createSessionToken } from "../src/session";

const env: Env = {
  GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "client-secret",
  SESSION_SECRET: "handler-test-secret",
};

const call = (path: string, init?: RequestInit): Promise<Response> =>
  worker.fetch!(
    new Request(`https://buktrakr.example${path}`, init),
    env,
    {} as never,
  );

describe("handlers (no network)", () => {
  it("GET /api/status without a cookie reports signed out", async () => {
    const res = await call("/api/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedIn: false });
  });

  it("GET /api/status with a valid session cookie reports signed in", async () => {
    const token = await createSessionToken(
      env.SESSION_SECRET,
      {
        sub: "s",
        email: "e@example.com",
        refreshToken: "rt",
        docId: "d1",
        sheetId: null,
        mode: "doc",
        docName: "BukTrakr — Book Reviews",
        style: "classic",
      },
      3600,
    );
    const res = await call("/api/status", {
      headers: { Cookie: `__Host-buktrakr_session=${token}` },
    });
    expect(await res.json()).toMatchObject({
      signedIn: true,
      email: "e@example.com",
      settings: { mode: "doc", style: "classic" },
      docUrl: "https://docs.google.com/document/d/d1/edit",
    });
  });

  it("POST /api/entries without a session is 401", async () => {
    const res = await call("/api/entries", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("cross-origin POSTs are rejected", async () => {
    const res = await call("/api/signout", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("same-origin POST /api/signout clears the session cookie", async () => {
    const res = await call("/api/signout", {
      method: "POST",
      headers: { Origin: "https://buktrakr.example" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain(
      "__Host-buktrakr_session=;",
    );
  });

  it("GET /auth/google redirects to Google with a state cookie", async () => {
    const res = await call("/auth/google");
    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(location).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location).toContain("drive.file");
    expect(res.headers.get("Set-Cookie")).toContain(
      "__Host-buktrakr_oauth_state=",
    );
  });

  it("GET /auth/google with missing secrets returns the misconfiguration 500", async () => {
    const res = await call("/auth/google").then(() =>
      worker.fetch!(
        new Request("https://buktrakr.example/auth/google"),
        { ...env, GOOGLE_CLIENT_ID: "", SESSION_SECRET: " " },
        {} as never,
      ),
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("GOOGLE_CLIENT_ID");
  });

  it("unknown routes are 404", async () => {
    const res = await call("/api/nope");
    expect(res.status).toBe(404);
  });
});
