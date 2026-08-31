"use client";

/**
 * Turning a dropped file into rows.
 *
 * The one place in the import path that needs the platform: a File, a text
 * decode, and an xlsx parser. Everything after this is `@munshi/core`, pure
 * and tested. Nothing is uploaded — a spreadsheet is read in the tab, the
 * same as everything else on an encrypted book (docs/E2EE.md §8).
 */
import { parseDelimited, type CellValue } from "@munshi/core";

export type SourceKind = "json" | "sheet";

export interface ReadFile {
  kind: SourceKind;
  /** Rows of the chosen sheet. */
  rows: CellValue[][];
  /** Every sheet in the workbook, so the caller can offer a choice. */
  sheets: { name: string; rows: CellValue[][] }[];
  /** Parsed JSON, for an archive. */
  json?: unknown;
  fileName: string;
}

const SHEET_EXT = /\.(xlsx|xlsm|xltx)$/i;
const TEXT_EXT = /\.(csv|tsv|txt)$/i;

export async function readImportFile(file: File): Promise<ReadFile> {
  const name = file.name;

  if (/\.json$/i.test(name)) {
    const text = await file.text();
    try {
      return { kind: "json", rows: [], sheets: [], json: JSON.parse(text), fileName: name };
    } catch {
      throw new Error("That .json file could not be parsed.");
    }
  }

  if (SHEET_EXT.test(name)) {
    // loaded on demand: the xlsx parser is far bigger than the rest of the
    // import path, and most imports are a CSV that never needs it
    const { default: readXlsxFile } = await import("read-excel-file/browser");
    // every sheet, not just the first: a bank's export often parks the
    // transactions behind a cover sheet, and picking the wrong one silently
    // imports nothing
    const book = await readXlsxFile(file);
    const sheets = book.map((s) => ({
      name: s.sheet,
      rows: s.data as unknown as CellValue[][],
    }));
    if (sheets.length === 0) throw new Error("That workbook has no sheets.");
    // open on the one with the most rows — the cover page is never the data
    const widest = sheets.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
    return { kind: "sheet", rows: widest.rows, sheets, fileName: name };
  }

  if (/\.xls$/i.test(name)) {
    throw new Error("That is the old .xls format. Open it and re-save as .xlsx or .csv.");
  }

  if (TEXT_EXT.test(name) || file.type.startsWith("text/")) {
    const rows = parseDelimited(await file.text());
    return { kind: "sheet", rows, sheets: [{ name, rows }], fileName: name };
  }

  throw new Error(`Munshi can read .json, .csv and .xlsx — not “${name}”.`);
}

export const IMPORT_ACCEPT = ".json,.csv,.tsv,.txt,.xlsx,.xlsm,.xltx";
