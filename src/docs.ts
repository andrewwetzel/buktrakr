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

/** Builds one entry's text block + style requests at a given insert index. */
function buildEntryBlock(
  entry: Entry,
  insertAt: number,
  style: StyleId,
  includeCover: boolean,
): { text: string; styleReqs: unknown[]; coverIndex: number | null } {
  const body = (s: string): string => neutralizeMetaLookalikes(clean(s)) || "—";
  const hasCover = includeCover && Boolean(entry.coverUrl);
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

  return {
    text,
    styleReqs: styleRequests(style, titleR, metaR, labelRs, blockEnd),
    coverIndex: coverR?.start ?? null,
  };
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
  const block = buildEntryBlock(entry, insertAt, style, true);
  const coverR = block.coverIndex !== null ? { start: block.coverIndex } : null;

  const requests = [
    { insertText: { location: { index: insertAt }, text: block.text } },
    ...block.styleReqs,
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

/**
 * Appends many entries in chunks (one insertText + styles per chunk). Used
 * for sheet→doc migration; cover images are not part of bulk appends.
 */
export async function appendEntriesBulk(
  accessToken: string,
  docId: string,
  entries: Entry[],
  style: StyleId,
): Promise<void> {
  const CHUNK = 50;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const { endIndex } = await getEndState(accessToken, docId);
    const insertAt = endIndex - 1;
    let text = "";
    const styleReqs: unknown[] = [];
    for (const entry of chunk) {
      const block = buildEntryBlock(
        entry,
        insertAt + text.length,
        style,
        false,
      );
      text += block.text;
      styleReqs.push(...block.styleReqs);
    }
    const res = await fetch(
      `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`,
      {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          requests: [
            { insertText: { location: { index: insertAt }, text } },
            ...styleReqs,
          ],
        }),
      },
    );
    if (res.status === 404) throw new DocNotFoundError();
    if (!res.ok) {
      throw new Error(`Bulk append failed: ${res.status} ${await res.text()}`);
    }
  }
}

// Section labels the parser and restyler recognize (current + legacy).
const LABEL_TO_FIELD: Record<string, "liked" | "disliked" | "notes"> = {
  "The Good": "liked",
  "What I liked": "liked",
  "The Bad": "disliked",
  "What I didn't like": "disliked",
  "The Other": "notes",
};

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

export interface FullEntry extends ParsedEntry {
  isbn: string;
  liked: string;
  disliked: string;
  notes: string;
}

/**
 * Like parseEntries, but also recovers ISBN and the section bodies — used
 * when migrating a doc's entries into the spreadsheet destination.
 */
export function parseEntriesFull(text: string): FullEntry[] {
  const lines = text.split("\n");
  const anchors: { titleIdx: number; metaIdx: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!META_LINE_RE.test(lines[i])) continue;
    let j = i - 1;
    while (j >= 0 && !lines[j].trim()) j--;
    if (j >= 0) anchors.push({ titleIdx: j, metaIdx: i });
  }

  const cleanBody = (parts: string[]): string => {
    const joined = parts
      .join("\n")
      .replace(/\u200B/g, "")
      .trim();
    return joined === "—" ? "" : joined;
  };

  return anchors.map((a, n) => {
    const titleLine = lines[a.titleIdx].trim();
    const sep = titleLine.lastIndexOf(" — ");
    const meta = lines[a.metaIdx];
    const m = meta.match(META_LINE_RE)!;
    const isbn = meta.match(/· ISBN ([0-9Xx-]+)/)?.[1] ?? "";

    const regionEnd = anchors[n + 1]?.titleIdx ?? lines.length;
    const buffers = { liked: [], disliked: [], notes: [] } as Record<
      "liked" | "disliked" | "notes",
      string[]
    >;
    let current: "liked" | "disliked" | "notes" | null = null;
    for (let i = a.metaIdx + 1; i < regionEnd; i++) {
      const field = LABEL_TO_FIELD[lines[i].trim()];
      if (field) {
        current = field;
        continue;
      }
      if (current) buffers[current].push(lines[i]);
    }

    return {
      title: sep > 0 ? titleLine.slice(0, sep) : titleLine,
      author: sep > 0 ? titleLine.slice(sep + 3) : "",
      rating: Number(m[1]),
      date: m[2],
      isbn,
      liked: cleanBody(buffers.liked),
      disliked: cleanBody(buffers.disliked),
      notes: cleanBody(buffers.notes),
    };
  });
}

// Every text-style property any template touches: used as the restyle field
// mask so properties a new template doesn't set are CLEARED, removing the
// previous template's colors/fonts.
const FULL_TEXT_FIELDS =
  "bold,italic,smallCaps,fontSize,foregroundColor,weightedFontFamily";

/**
 * Restyles every existing entry in the doc to the given template. Formatting
 * only — never inserts, deletes, or edits text (Docs version history is the
 * undo). Returns the number of entries restyled.
 */
export async function restyleDoc(
  accessToken: string,
  docId: string,
  style: StyleId,
): Promise<number> {
  const def = STYLE_DEFS[style] ?? STYLE_DEFS.classic;
  const res = await fetch(
    `https://docs.googleapis.com/v1/documents/${docId}?fields=body(content(startIndex,endIndex,paragraph(elements(textRun(content)))))`,
    { headers: authHeaders(accessToken) },
  );
  if (res.status === 404) throw new DocNotFoundError();
  if (!res.ok) throw new Error(`Doc read failed: ${res.status}`);
  const body = (await res.json()) as {
    body?: {
      content?: {
        startIndex?: number;
        endIndex?: number;
        paragraph?: { elements?: { textRun?: { content?: string } }[] };
      }[];
    };
  };
  const paras: { start: number; end: number; text: string }[] = [];
  let docEnd = 1;
  for (const el of body.body?.content ?? []) {
    if (typeof el.endIndex === "number") docEnd = el.endIndex;
    if (!el.paragraph || typeof el.endIndex !== "number") continue;
    let text = "";
    for (const pe of el.paragraph.elements ?? [])
      text += pe.textRun?.content ?? "";
    paras.push({ start: el.startIndex ?? 0, end: el.endIndex, text });
  }

  const anchors: { titleP: number; metaP: number }[] = [];
  for (let i = 0; i < paras.length; i++) {
    if (!META_LINE_RE.test(paras[i].text.trim())) continue;
    let j = i - 1;
    while (j >= 0 && !paras[j].text.trim()) j--;
    if (j >= 0) anchors.push({ titleP: j, metaP: i });
  }
  if (anchors.length === 0) return 0;

  const para = (start: number, end: number, namedStyleType: string) => ({
    updateParagraphStyle: {
      range: { startIndex: start, endIndex: end },
      paragraphStyle: { namedStyleType },
      fields: "namedStyleType",
    },
  });
  const text = (
    start: number,
    end: number,
    textStyle: TextStyle,
    fields: string,
  ) => ({
    updateTextStyle: {
      range: { startIndex: start, endIndex: end },
      textStyle,
      fields,
    },
  });

  const requests: unknown[] = [];
  anchors.forEach((a, n) => {
    const titleP = paras[a.titleP];
    const metaP = paras[a.metaP];
    const regionEnd = anchors[n + 1]
      ? paras[anchors[n + 1].titleP].start
      : docEnd;
    // The doc's final newline can't be text-styled.
    const styleEnd = Math.min(regionEnd, docEnd - 1);

    requests.push(para(titleP.start, titleP.end, def.titlePara));
    if (regionEnd > titleP.end) {
      requests.push(para(titleP.end, regionEnd, "NORMAL_TEXT"));
    }
    // Whole-entry font pass: sets the template's block font or clears one.
    requests.push(
      text(titleP.start, styleEnd, def.block ?? {}, "weightedFontFamily"),
    );
    requests.push(
      text(titleP.start, titleP.end - 1, def.title ?? {}, FULL_TEXT_FIELDS),
    );
    requests.push(text(metaP.start, metaP.end - 1, def.meta, FULL_TEXT_FIELDS));
    for (let i = a.metaP + 1; i < paras.length; i++) {
      if (paras[i].start >= regionEnd) break;
      if (LABEL_TO_FIELD[paras[i].text.trim()]) {
        requests.push(
          text(paras[i].start, paras[i].end - 1, def.label, FULL_TEXT_FIELDS),
        );
      }
    }
  });

  const CHUNK = 400;
  for (let i = 0; i < requests.length; i += CHUNK) {
    const r = await fetch(
      `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`,
      {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({ requests: requests.slice(i, i + CHUNK) }),
      },
    );
    if (r.status === 404) throw new DocNotFoundError();
    if (!r.ok) throw new Error(`Restyle failed: ${r.status} ${await r.text()}`);
  }
  return anchors.length;
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
