// Google Sheets destination (optional alternative to the Doc): one row per
// entry, header row frozen. Works under drive.file for spreadsheets the app
// creates. Requires the Google Sheets API to be enabled in the GCP project.

import {
  DocNotFoundError,
  type Entry,
  type ParsedEntry,
  type StyleId,
} from "./docs";

export const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const HEADER = [
  "Date",
  "Title",
  "Author",
  "Rating",
  "ISBN",
  "The Good",
  "The Bad",
  "The Other",
];
// Pixel widths per column: dates/ratings stay narrow, review text gets room
// (cells wrap, so long reviews grow rows instead of overflowing).
const COLUMN_WIDTHS = [95, 220, 150, 65, 120, 280, 280, 280];

interface SheetColor {
  red: number;
  green: number;
  blue: number;
}
const hex = (h: string): SheetColor => {
  const n = parseInt(h.slice(1), 16);
  return {
    red: ((n >> 16) & 255) / 255,
    green: ((n >> 8) & 255) / 255,
    blue: (n & 255) / 255,
  };
};
const WHITE = hex("#FFFFFF");

interface SheetTheme {
  header: SheetColor;
  headerText: SheetColor;
  band: SheetColor;
  fontFamily?: string;
}

// One theme per StyleId — same palette family as the doc templates.
const SHEET_THEMES: Record<StyleId, SheetTheme> = {
  classic: { header: hex("#3B6E4F"), headerText: WHITE, band: hex("#F1EFE8") },
  minimal: {
    header: hex("#F2F2F2"),
    headerText: hex("#202124"),
    band: hex("#FAFAFA"),
  },
  vintage: { header: hex("#3B6E4F"), headerText: WHITE, band: hex("#EDF2ED") },
  ocean: { header: hex("#1B4F72"), headerText: WHITE, band: hex("#EAF1F7") },
  sunset: { header: hex("#A04000"), headerText: WHITE, band: hex("#FBF0E6") },
  royal: { header: hex("#5B2C6F"), headerText: WHITE, band: hex("#F3EDF7") },
  typewriter: {
    header: hex("#333333"),
    headerText: WHITE,
    band: hex("#F5F5F5"),
    fontFamily: "Courier New",
  },
  rose: { header: hex("#B03A5B"), headerText: WHITE, band: hex("#FAEDF1") },
};

/**
 * Applies a theme to the whole sheet: colored bold header, alternating row
 * banding, per-column widths, and wrapped top-aligned cells. Idempotent —
 * existing banding is replaced, not stacked.
 */
export async function applySheetStyle(
  accessToken: string,
  sheetId: string,
  style: StyleId,
): Promise<void> {
  const theme = SHEET_THEMES[style] ?? SHEET_THEMES.classic;
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets(properties(sheetId,gridProperties(rowCount)),bandedRanges(bandedRangeId))`,
    { headers: authHeaders(accessToken) },
  );
  if (metaRes.status === 404) throw new DocNotFoundError();
  if (!metaRes.ok) throw new Error(`Sheet meta failed: ${metaRes.status}`);
  const meta = (await metaRes.json()) as {
    sheets?: {
      properties?: { sheetId?: number; gridProperties?: { rowCount?: number } };
      bandedRanges?: { bandedRangeId?: number }[];
    }[];
  };
  const first = meta.sheets?.[0];
  const gridId = first?.properties?.sheetId ?? 0;
  const rowCount = first?.properties?.gridProperties?.rowCount ?? 1000;
  const bandIds = (meta.sheets ?? [])
    .flatMap((s) => (s.bandedRanges ?? []).map((b) => b.bandedRangeId))
    .filter((id): id is number => typeof id === "number");

  const grid = {
    sheetId: gridId,
    startRowIndex: 0,
    endRowIndex: rowCount,
    startColumnIndex: 0,
    endColumnIndex: HEADER.length,
  };
  const requests: unknown[] = [
    ...bandIds.map((id) => ({ deleteBanding: { bandedRangeId: id } })),
    {
      updateSheetProperties: {
        properties: { sheetId: gridId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    },
    {
      repeatCell: {
        range: grid,
        cell: {
          userEnteredFormat: {
            wrapStrategy: "WRAP",
            verticalAlignment: "TOP",
            ...(theme.fontFamily
              ? { textFormat: { fontFamily: theme.fontFamily } }
              : {}),
          },
        },
        fields: theme.fontFamily
          ? "userEnteredFormat(wrapStrategy,verticalAlignment,textFormat.fontFamily)"
          : "userEnteredFormat(wrapStrategy,verticalAlignment)",
      },
    },
    {
      repeatCell: {
        range: { ...grid, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            textFormat: {
              bold: true,
              foregroundColor: theme.headerText,
              ...(theme.fontFamily ? { fontFamily: theme.fontFamily } : {}),
            },
          },
        },
        fields:
          "userEnteredFormat.textFormat(bold,foregroundColor" +
          (theme.fontFamily ? ",fontFamily)" : ")"),
      },
    },
    {
      addBanding: {
        bandedRange: {
          range: grid,
          rowProperties: {
            headerColor: theme.header,
            firstBandColor: WHITE,
            secondBandColor: theme.band,
          },
        },
      },
    },
    ...COLUMN_WIDTHS.map((pixelSize, i) => ({
      updateDimensionProperties: {
        range: {
          sheetId: gridId,
          dimension: "COLUMNS",
          startIndex: i,
          endIndex: i + 1,
        },
        properties: { pixelSize },
        fields: "pixelSize",
      },
    })),
  ];

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`,
    {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ requests }),
    },
  );
  if (res.status === 404) throw new DocNotFoundError();
  if (!res.ok)
    throw new Error(`Sheet style failed: ${res.status} ${await res.text()}`);
}

function authHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

export function sheetUrl(sheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
}

export async function createSheet(
  accessToken: string,
  name: string,
  style: StyleId = "classic",
): Promise<string> {
  const res = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify({
      properties: { title: name },
      sheets: [
        {
          properties: {
            title: "Reviews",
            gridProperties: { frozenRowCount: 1 },
          },
        },
      ],
    }),
  });
  if (!res.ok)
    throw new Error(`Sheet creation failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { spreadsheetId?: string };
  if (!body.spreadsheetId) throw new Error("Sheet creation returned no id");

  // Header row values; ranges without a tab name hit the first sheet, so a
  // later tab rename doesn't break appends.
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${body.spreadsheetId}/values/A1:H1?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ values: [HEADER] }),
    },
  );
  await applySheetStyle(accessToken, body.spreadsheetId, style);
  return body.spreadsheetId;
}

/** The column subset a row carries (Entry and FullEntry both satisfy it). */
export interface RowInput {
  date: string;
  title: string;
  author: string;
  rating: number;
  isbn: string;
  liked: string;
  disliked: string;
  notes: string;
}

export async function appendRows(
  accessToken: string,
  sheetId: string,
  entries: RowInput[],
): Promise<void> {
  if (entries.length === 0) return;
  // RAW keeps user text literal — "=SUM(...)" in a review must never be
  // interpreted as a formula.
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A1:append?valueInputOption=RAW`,
    {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        values: entries.map((e) => [
          e.date,
          e.title,
          e.author,
          e.rating,
          e.isbn,
          e.liked,
          e.disliked,
          e.notes,
        ]),
      }),
    },
  );
  if (res.status === 404) throw new DocNotFoundError();
  if (!res.ok)
    throw new Error(`Sheet append failed: ${res.status} ${await res.text()}`);
}

export const appendRow = (
  accessToken: string,
  sheetId: string,
  entry: Entry,
): Promise<void> => appendRows(accessToken, sheetId, [entry]);

export interface SheetRow extends ParsedEntry {
  isbn: string;
  liked: string;
  disliked: string;
  notes: string;
}

export async function readRows(
  accessToken: string,
  sheetId: string,
): Promise<SheetRow[]> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A2:H100000`,
    { headers: authHeaders(accessToken) },
  );
  if (res.status === 404) throw new DocNotFoundError();
  if (!res.ok) throw new Error(`Sheet read failed: ${res.status}`);
  const body = (await res.json()) as { values?: unknown[][] };
  const rows: SheetRow[] = [];
  for (const v of body.values ?? []) {
    const s = (i: number): string =>
      typeof v[i] === "string" ? (v[i] as string) : String(v[i] ?? "");
    const rating = Number(v[3]);
    if (!s(1) || !Number.isFinite(rating)) continue;
    rows.push({
      date: s(0),
      title: s(1),
      author: s(2),
      rating,
      isbn: s(4),
      liked: s(5),
      disliked: s(6),
      notes: s(7),
    });
  }
  return rows;
}

/** Renders sheet rows as readable text for the AI-recommendations export. */
export function rowsToText(rows: SheetRow[]): string {
  return rows
    .map(
      (r) =>
        `${r.title}${r.author ? ` — ${r.author}` : ""}\n` +
        `Rating: ${r.rating}/10 · ${r.date}${r.isbn ? ` · ISBN ${r.isbn}` : ""}\n` +
        `The Good\n${r.liked || "—"}\nThe Bad\n${r.disliked || "—"}\nThe Other\n${r.notes || "—"}\n`,
    )
    .join("\n");
}
