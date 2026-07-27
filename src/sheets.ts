// Google Sheets destination (optional alternative to the Doc): one row per
// entry, header row frozen. Works under drive.file for spreadsheets the app
// creates. Requires the Google Sheets API to be enabled in the GCP project.

import { DocNotFoundError, type Entry, type ParsedEntry } from "./docs";

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
  const body = (await res.json()) as {
    spreadsheetId?: string;
    sheets?: { properties?: { sheetId?: number } }[];
  };
  if (!body.spreadsheetId) throw new Error("Sheet creation returned no id");

  // Header row + bold formatting; ranges without a tab name hit the first
  // sheet, so a later tab rename doesn't break appends.
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${body.spreadsheetId}/values/A1:H1?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ values: [HEADER] }),
    },
  );
  const gridId = body.sheets?.[0]?.properties?.sheetId ?? 0;
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${body.spreadsheetId}:batchUpdate`,
    {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        requests: [
          {
            repeatCell: {
              range: { sheetId: gridId, startRowIndex: 0, endRowIndex: 1 },
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: "userEnteredFormat.textFormat.bold",
            },
          },
        ],
      }),
    },
  );
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
