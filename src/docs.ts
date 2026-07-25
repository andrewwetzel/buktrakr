// Google Drive (doc creation) and Google Docs (append) via raw fetch.
// Both work under the drive.file scope because the app creates the doc.

export const DOC_TITLE = "BukTrakr — Book Reviews";

/** The doc was deleted from Drive; caller should create a fresh one and retry. */
export class DocNotFoundError extends Error {}

export interface Entry {
  title: string;
  author: string;
  rating: number;
  liked: string;
  disliked: string;
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
}

export async function createDoc(accessToken: string): Promise<string> {
  const res = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify({
      name: DOC_TITLE,
      mimeType: "application/vnd.google-apps.document",
    }),
  });
  if (!res.ok) throw new Error(`Doc creation failed: ${res.status}`);
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new Error("Doc creation returned no id");
  return body.id;
}

export function docUrl(docId: string): string {
  return `https://docs.google.com/document/d/${docId}/edit`;
}

/**
 * Finds the reviews doc among files this app created (all drive.file lets it
 * see), so a sign-in from a fresh browser reuses the existing doc instead of
 * creating a duplicate. Returns the oldest match or null.
 */
export async function findDoc(accessToken: string): Promise<string | null> {
  const q = `name = '${DOC_TITLE}' and mimeType = 'application/vnd.google-apps.document' and trashed = false`;
  const params = new URLSearchParams({
    q,
    orderBy: "createdTime",
    pageSize: "1",
    fields: "files(id)",
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw new Error(`Doc search failed: ${res.status}`);
  const body = (await res.json()) as { files?: { id?: string }[] };
  return body.files?.[0]?.id ?? null;
}

async function getEndIndex(accessToken: string, docId: string): Promise<number> {
  const res = await fetch(
    `https://docs.googleapis.com/v1/documents/${docId}?fields=body(content(endIndex))`,
    { headers: authHeaders(accessToken) }
  );
  if (res.status === 404) throw new DocNotFoundError();
  if (!res.ok) throw new Error(`Doc fetch failed: ${res.status}`);
  const body = (await res.json()) as { body?: { content?: { endIndex?: number }[] } };
  const content = body.body?.content ?? [];
  const end = content[content.length - 1]?.endIndex;
  if (typeof end !== "number") throw new Error("Doc has no end index");
  return end;
}

const clean = (s: string): string =>
  s.replace(/\r/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

/**
 * Appends a formatted entry at the end of the doc. One insertText plus style
 * requests over sub-ranges computed locally. Offsets are UTF-16 code units
 * (JS string.length), which is exactly how the Docs API indexes text.
 */
export async function appendEntry(accessToken: string, docId: string, entry: Entry): Promise<void> {
  // The body's final newline cannot be inserted at/after, hence -1.
  const insertAt = (await getEndIndex(accessToken, docId)) - 1;

  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    clean(`${entry.title} — ${entry.author}`),
    `Rating: ${entry.rating}/10 · ${date}`,
    "What I liked",
    clean(entry.liked.trim()) || "—",
    "What I didn't like",
    clean(entry.disliked.trim()) || "—",
  ];

  let text = "";
  const ranges: { start: number; end: number }[] = [];
  for (const line of lines) {
    ranges.push({ start: insertAt + text.length, end: insertAt + text.length + line.length });
    text += line + "\n";
  }
  const [titleR, ratingR, likedLabelR, , dislikedLabelR] = ranges;
  const blockEnd = insertAt + text.length;

  const requests = [
    { insertText: { location: { index: insertAt }, text } },
    {
      updateParagraphStyle: {
        range: { startIndex: titleR.start, endIndex: titleR.end + 1 },
        paragraphStyle: { namedStyleType: "HEADING_2" },
        fields: "namedStyleType",
      },
    },
    // Explicit NORMAL_TEXT so the rest never inherits heading style.
    {
      updateParagraphStyle: {
        range: { startIndex: ratingR.start, endIndex: blockEnd },
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        fields: "namedStyleType",
      },
    },
    {
      updateTextStyle: {
        range: { startIndex: ratingR.start, endIndex: ratingR.end },
        textStyle: { italic: true },
        fields: "italic",
      },
    },
    {
      updateTextStyle: {
        range: { startIndex: likedLabelR.start, endIndex: likedLabelR.end },
        textStyle: { bold: true },
        fields: "bold",
      },
    },
    {
      updateTextStyle: {
        range: { startIndex: dislikedLabelR.start, endIndex: dislikedLabelR.end },
        textStyle: { bold: true },
        fields: "bold",
      },
    },
  ];

  const res = await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify({ requests }),
  });
  if (res.status === 404) throw new DocNotFoundError();
  if (!res.ok) throw new Error(`Doc append failed: ${res.status} ${await res.text()}`);
}
