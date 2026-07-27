// Google Drive (doc creation) and Google Docs (append) via raw fetch.
// Both work under the drive.file scope because the app creates the doc.

export const DOC_TITLE = "BukTrakr — Book Reviews";
export const DOC_MIME = "application/vnd.google-apps.document";

/** Doc styling templates users can pick in Settings. */
export const STYLE_IDS = [
  "classic",
  "minimal",
  "vintage",
  "ocean",
  "sunset",
  "royal",
  "typewriter",
  "rose",
] as const;
export type StyleId = (typeof STYLE_IDS)[number];

/** The doc was deleted from Drive; caller should create a fresh one and retry. */
export class DocNotFoundError extends Error {}

export interface Entry {
  title: string;
  author: string;
  rating: number;
  /** YYYY-MM-DD "date read" (defaults to submission day server-side). */
  date: string;
  isbn: string;
  coverUrl: string;
  liked: string;
  disliked: string;
  notes: string;
}

function authHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

export async function createDoc(
  accessToken: string,
  name: string,
): Promise<string> {
  const res = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify({ name, mimeType: DOC_MIME }),
  });
  if (!res.ok) throw new Error(`Doc creation failed: ${res.status}`);
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new Error("Doc creation returned no id");
  return body.id;
}

/** Renames a Drive file (doc or spreadsheet). */
export async function renameFile(
  accessToken: string,
  fileId: string,
  name: string,
): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}`,
    {
      method: "PATCH",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ name }),
    },
  );
  if (res.status === 404) throw new DocNotFoundError();
  if (!res.ok) throw new Error(`Rename failed: ${res.status}`);
}

// App-private Drive file metadata (appProperties) — how settings sync across
// devices: the active destination file carries the flag + style, its name is
// the display name, and sign-in reads it all back. drive.file covers this.
export const PROP_ACTIVE = "buktrakrActive";
export const PROP_STYLE = "buktrakrStyle";

export interface DriveFileInfo {
  id: string;
  mimeType: string;
  name: string;
  appProperties?: Record<string, string>;
}

/** All files this app created (docs + sheets), oldest first. */
export async function listAppFiles(
  accessToken: string,
): Promise<DriveFileInfo[]> {
  const params = new URLSearchParams({
    q: "trashed = false",
    orderBy: "createdTime",
    pageSize: "10",
    fields: "files(id,mimeType,name,appProperties)",
  });
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params}`,
    { headers: authHeaders(accessToken) },
  );
  if (!res.ok) throw new Error(`Drive list failed: ${res.status}`);
  const body = (await res.json()) as { files?: DriveFileInfo[] };
  return (body.files ?? []).filter((f) => f.id && f.mimeType);
}

/** Sets (or with null values, removes) app-private properties on a file. */
export async function setFileProps(
  accessToken: string,
  fileId: string,
  props: Record<string, string | null>,
): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}`,
    {
      method: "PATCH",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ appProperties: props }),
    },
  );
  if (res.status === 404) throw new DocNotFoundError();
  if (!res.ok) throw new Error(`Props update failed: ${res.status}`);
}

export function docUrl(docId: string): string {
  return `https://docs.google.com/document/d/${docId}/edit`;
}

/**
 * Finds the reviews destination among files this app created (all drive.file
 * lets it see), so a sign-in from a fresh browser reuses the existing file
 * instead of creating a duplicate. Matches by type only — custom names are
 * still rediscovered. Returns the oldest match or null.
 */
export async function findFile(
  accessToken: string,
  mimeType: string,
): Promise<string | null> {
  const q = `mimeType = '${mimeType}' and trashed = false`;
  const params = new URLSearchParams({
    q,
    orderBy: "createdTime",
    pageSize: "1",
    fields: "files(id)",
  });
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params}`,
    {
      headers: authHeaders(accessToken),
    },
  );
  if (!res.ok) throw new Error(`Doc search failed: ${res.status}`);
  const body = (await res.json()) as { files?: { id?: string }[] };
  return body.files?.[0]?.id ?? null;
}

async function getEndState(
  accessToken: string,
  docId: string,
): Promise<{ endIndex: number; revisionId: string }> {
  const res = await fetch(
    `https://docs.googleapis.com/v1/documents/${docId}?fields=revisionId,body(content(endIndex))`,
    { headers: authHeaders(accessToken) },
  );
  if (res.status === 404) throw new DocNotFoundError();
  if (!res.ok) throw new Error(`Doc fetch failed: ${res.status}`);
  const body = (await res.json()) as {
    revisionId?: string;
    body?: { content?: { endIndex?: number }[] };
  };
  const content = body.body?.content ?? [];
  const end = content[content.length - 1]?.endIndex;
  if (typeof end !== "number" || !body.revisionId)
    throw new Error("Doc has no end state");
  return { endIndex: end, revisionId: body.revisionId };
}

// ---- Meta-line format: a contract between the writer (appendEntry) and the
// ---- reader (parseEntries). Change these together or old entries stop being
// ---- counted by /api/recent.
export const META_SEP = " · ";
const metaLine = (e: Entry): string =>
  [
    `Rating: ${e.rating}/10`,
    e.date,
    ...(e.isbn ? [`ISBN ${e.isbn}`] : []),
  ].join(META_SEP);
const META_LINE_RE = new RegExp(
  `^Rating: (\\d{1,2})/10${META_SEP}(\\d{4}-\\d{2}-\\d{2})`,
);

// A body line that happens to look like a meta line would forge a phantom
// entry in parseEntries; an invisible zero-width space breaks the match.
const neutralizeMetaLookalikes = (s: string): string =>
  s.replace(/^(\s*Rating: \d{1,2}\/10)/gm, "\u200B$1");

const clean = (s: string): string =>
  s.replace(/\r/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

/**
 * Appends a formatted entry at the end of the doc. One insertText plus style
 * requests over sub-ranges computed locally. Offsets are UTF-16 code units
 * (JS string.length), which is exactly how the Docs API indexes text.
 */
export async function appendEntry(
  accessToken: string,
  docId: string,
  entry: Entry,
  style: StyleId = "classic",
): Promise<void> {
  // The read-then-write pair races with concurrent edits to the doc, so the
  // batch carries writeControl.requiredRevisionId and gets one retry.
  for (let attempt = 0; ; attempt++) {
    const { endIndex, revisionId } = await getEndState(accessToken, docId);
    const done = await tryAppendAt(
      accessToken,
      docId,
      entry,
      endIndex - 1,
      revisionId,
      style,
    );
    if (done) return;
    if (attempt >= 1) throw new Error("Doc append failed: revision conflict");
  }
}

interface Range {
  start: number;
  end: number;
}

type TextStyle = Record<string, unknown>;

interface StyleDef {
  /** Paragraph style for the title line. */
  titlePara: "HEADING_2" | "NORMAL_TEXT";
  /** Text style applied to the whole entry block first (others override). */
  block?: TextStyle;
  title?: TextStyle;
  meta: TextStyle;
  label: TextStyle;
}

const rgb = (hex: string): { color: { rgbColor: Record<string, number> } } => {
  const n = parseInt(hex.slice(1), 16);
  return {
    color: {
      rgbColor: {
        red: ((n >> 16) & 255) / 255,
        green: ((n >> 8) & 255) / 255,
        blue: (n & 255) / 255,
      },
    },
  };
};
const pt = (magnitude: number) => ({ magnitude, unit: "PT" });
const font = (fontFamily: string) => ({ weightedFontFamily: { fontFamily } });

// Keep in sync with the preview cards in public/index.html (.prev-<id>).
const STYLE_DEFS: Record<StyleId, StyleDef> = {
  classic: {
    titlePara: "HEADING_2",
    meta: { italic: true },
    label: { bold: true },
  },
  minimal: {
    titlePara: "NORMAL_TEXT",
    title: { bold: true, fontSize: pt(13) },
    meta: { italic: true, foregroundColor: rgb("#737165") },
    label: { bold: true },
  },
  vintage: {
    titlePara: "HEADING_2",
    title: { foregroundColor: rgb("#3B6E4F"), ...font("Playfair Display") },
    meta: { italic: true },
    label: { bold: true, smallCaps: true },
  },
  ocean: {
    titlePara: "HEADING_2",
    title: { foregroundColor: rgb("#1B4F72"), ...font("Merriweather") },
    meta: { italic: true, foregroundColor: rgb("#5D6D7E") },
    label: { bold: true, foregroundColor: rgb("#21618C") },
  },
  sunset: {
    titlePara: "HEADING_2",
    title: { foregroundColor: rgb("#A04000"), ...font("Lora") },
    meta: { italic: true, foregroundColor: rgb("#935116") },
    label: { bold: true, foregroundColor: rgb("#CA6F1E") },
  },
  royal: {
    titlePara: "HEADING_2",
    title: { foregroundColor: rgb("#5B2C6F"), ...font("Playfair Display") },
    meta: { italic: true, foregroundColor: rgb("#7D3C98") },
    label: { bold: true, smallCaps: true, foregroundColor: rgb("#6C3483") },
  },
  typewriter: {
    titlePara: "NORMAL_TEXT",
    block: font("Courier New"),
    title: { bold: true, fontSize: pt(13) },
    meta: { italic: true },
    label: { bold: true },
  },
  rose: {
    titlePara: "HEADING_2",
    title: { foregroundColor: rgb("#B03A5B"), ...font("Lora") },
    meta: { italic: true, foregroundColor: rgb("#8E3A4D") },
    label: { bold: true, foregroundColor: rgb("#B03A5B") },
  },
};

/**
 * Per-template styling requests. Every template styles the same pieces
 * (title paragraph, optional whole-block font, meta line, section labels).
 */
function styleRequests(
  style: StyleId,
  titleR: Range,
  metaR: Range,
  labelRs: Range[],
  blockEnd: number,
): unknown[] {
  const def = STYLE_DEFS[style] ?? STYLE_DEFS.classic;
  const para = (r: Range, namedStyleType: string) => ({
    updateParagraphStyle: {
      range: { startIndex: r.start, endIndex: r.end },
      paragraphStyle: { namedStyleType },
      fields: "namedStyleType",
    },
  });
  const text = (r: Range, textStyle: TextStyle) => ({
    updateTextStyle: {
      range: { startIndex: r.start, endIndex: r.end },
      textStyle,
      fields: Object.keys(textStyle).join(","),
    },
  });
  // The block after the title is explicitly NORMAL_TEXT in every template so
  // nothing inherits heading style.
  const requests: unknown[] = [
    para({ start: titleR.start, end: titleR.end + 1 }, def.titlePara),
    para({ start: titleR.end + 1, end: blockEnd }, "NORMAL_TEXT"),
  ];
  if (def.block) {
    requests.push(text({ start: titleR.start, end: blockEnd }, def.block));
  }
  if (def.title) requests.push(text(titleR, def.title));
  requests.push(text(metaR, def.meta));
  for (const r of labelRs) requests.push(text(r, def.label));
  return requests;
}

/** One append attempt; returns false on a revision/index conflict (retryable). */
async function tryAppendAt(
  accessToken: string,
  docId: string,
  entry: Entry,
  insertAt: number,
  revisionId: string,
  style: StyleId,
): Promise<boolean> {
  const body = (s: string): string => neutralizeMetaLookalikes(clean(s)) || "—";
  const hasCover = Boolean(entry.coverUrl);
  const parts: {
    text: string;
    kind: "title" | "cover" | "meta" | "label" | "body";
  }[] = [
    { text: clean(`${entry.title} — ${entry.author}`), kind: "title" },
    // Empty paragraph reserved for the inline cover image.
    ...(hasCover ? [{ text: "", kind: "cover" as const }] : []),
    { text: metaLine(entry), kind: "meta" },
    { text: "The Good", kind: "label" },
    { text: body(entry.liked), kind: "body" },
    { text: "The Bad", kind: "label" },
    { text: body(entry.disliked), kind: "body" },
    { text: "The Other", kind: "label" },
    { text: body(entry.notes), kind: "body" },
  ];

  let text = "";
  const ranges: { kind: string; start: number; end: number }[] = [];
  for (const part of parts) {
    ranges.push({
      kind: part.kind,
      start: insertAt + text.length,
      end: insertAt + text.length + part.text.length,
    });
    text += part.text + "\n";
  }
  // title and meta always exist in parts; cover is conditional.
  const rangeOf = (kind: string) => ranges.find((r) => r.kind === kind);
  const titleR = rangeOf("title")!;
  const metaR = rangeOf("meta")!;
  const coverR = rangeOf("cover");
  const labelRs = ranges.filter((r) => r.kind === "label");
  const blockEnd = insertAt + text.length;

  const requests = [
    { insertText: { location: { index: insertAt }, text } },
    ...styleRequests(style, titleR, metaR, labelRs, blockEnd),
  ];

  const res = await fetch(
    `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`,
    {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        requests,
        writeControl: { requiredRevisionId: revisionId },
      }),
    },
  );
  if (res.status === 404) throw new DocNotFoundError();
  if (res.status === 400) return false; // stale revision or index — caller retries once
  if (!res.ok)
    throw new Error(`Doc append failed: ${res.status} ${await res.text()}`);

  // The cover goes in a separate batch: Google fetches the image URL
  // server-side and can refuse (stale link, size), and that must never cost
  // the user their review text — so failures here are swallowed.
  if (coverR) {
    try {
      await fetch(
        `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`,
        {
          method: "POST",
          headers: authHeaders(accessToken),
          body: JSON.stringify({
            requests: [
              {
                insertInlineImage: {
                  location: { index: coverR.start },
                  uri: entry.coverUrl,
                  objectSize: { height: { magnitude: 120, unit: "PT" } },
                },
              },
            ],
          }),
        },
      );
    } catch {
      // Best-effort only.
    }
  }
  return true;
}

export interface ParsedEntry {
  title: string;
  author: string;
  rating: number;
  date: string;
}

/**
 * Recovers the logged entries from the doc's plain text: a meta line marks an
 * entry, and the nearest preceding non-empty line is its title heading.
 * Tolerant of format drift — only those two lines matter.
 */
export function parseEntries(text: string): ParsedEntry[] {
  const lines = text.split("\n");
  const entries: ParsedEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(META_LINE_RE);
    if (!m) continue;
    let j = i - 1;
    while (j >= 0 && !lines[j].trim()) j--;
    if (j < 0) continue;
    const titleLine = lines[j].trim();
    const sep = titleLine.lastIndexOf(" — ");
    entries.push({
      title: sep > 0 ? titleLine.slice(0, sep) : titleLine,
      author: sep > 0 ? titleLine.slice(sep + 3) : "",
      rating: Number(m[1]),
      date: m[2],
    });
  }
  return entries;
}

/** Full plain text of the doc (for the AI-recommendations export). */
export async function getDocText(
  accessToken: string,
  docId: string,
): Promise<string> {
  const res = await fetch(
    `https://docs.googleapis.com/v1/documents/${docId}?fields=body(content(paragraph(elements(textRun(content)))))`,
    { headers: authHeaders(accessToken) },
  );
  if (res.status === 404) throw new DocNotFoundError();
  if (!res.ok) throw new Error(`Doc read failed: ${res.status}`);
  const body = (await res.json()) as {
    body?: {
      content?: {
        paragraph?: { elements?: { textRun?: { content?: string } }[] };
      }[];
    };
  };
  let text = "";
  for (const el of body.body?.content ?? []) {
    for (const pe of el.paragraph?.elements ?? []) {
      text += pe.textRun?.content ?? "";
    }
  }
  return text;
}
