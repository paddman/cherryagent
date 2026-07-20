import { createHash } from "node:crypto";
import { extname } from "node:path";
import ExcelJS from "exceljs";
import { parse as parseCsv } from "csv-parse/sync";
import type { ParsedTable, ReportQualityWarning, TableScalar } from "./types.js";

export type TabularParserOptions = {
  maxBytes: number;
  maxRows: number;
  maxColumns: number;
};

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function uniqueHeaders(values: unknown[], warnings: ReportQualityWarning[]): string[] {
  const counts = new Map<string, number>();
  return values.map((value, index) => {
    const base = text(value) || `Column ${index + 1}`;
    const count = (counts.get(base.toLowerCase()) ?? 0) + 1;
    counts.set(base.toLowerCase(), count);
    if (count > 1) warnings.push({ code: "duplicate_header", message: `Duplicate header '${base}' was renamed.`, column: base });
    return count === 1 ? base : `${base} (${count})`;
  });
}

function excelScalar(value: ExcelJS.CellValue, formulaCounter: { value: number }): TableScalar {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "object") {
    if ("formula" in value || "sharedFormula" in value) {
      formulaCounter.value += 1;
      const result = "result" in value ? value.result : null;
      return excelScalar((result ?? null) as ExcelJS.CellValue, formulaCounter);
    }
    if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((item) => item.text).join("");
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("error" in value) return null;
  }
  return text(value);
}

function rowValues(worksheet: ExcelJS.Worksheet, rowNumber: number, columns: number, formulaCounter: { value: number }): TableScalar[] {
  const row = worksheet.getRow(rowNumber);
  return Array.from({ length: columns }, (_, index) => excelScalar(row.getCell(index + 1).value, formulaCounter));
}

function nonEmptyCount(values: TableScalar[]): number {
  return values.filter((value) => value !== null && text(value) !== "").length;
}

export class TabularParser {
  constructor(private readonly options: TabularParserOptions) {}

  validate(fileName: string, mimeType: string, buffer: Buffer): ".xlsx" | ".csv" {
    if (!buffer.length) throw new Error("Uploaded file is empty");
    if (buffer.length > this.options.maxBytes) throw new Error(`File exceeds ${Math.round(this.options.maxBytes / 1024 / 1024)} MB limit`);
    const extension = extname(fileName).toLowerCase();
    const leading = buffer.subarray(0, Math.min(buffer.length, 8));
    const executableSignature = (leading[0] === 0x4d && leading[1] === 0x5a)
      || (leading[0] === 0x7f && leading[1] === 0x45 && leading[2] === 0x4c && leading[3] === 0x46)
      || (leading[0] === 0xcf && leading[1] === 0xfa && leading[2] === 0xed && leading[3] === 0xfe)
      || (leading[0] === 0xfe && leading[1] === 0xed && leading[2] === 0xfa && leading[3] === 0xcf)
      || (leading[0] === 0x23 && leading[1] === 0x21);
    if (executableSignature) throw new Error("Executable content is not accepted as a report source");
    if (extension === ".xls" || extension === ".xlsm") throw new Error("Legacy or macro-enabled Excel files are not supported; save as .xlsx or .csv");
    if (extension !== ".xlsx" && extension !== ".csv") throw new Error("Only .xlsx and .csv files are supported");
    if (extension === ".xlsx" && !(buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04)) {
      throw new Error("The .xlsx file signature is invalid");
    }
    if (extension === ".xlsx") {
      const normalizedMime = mimeType.toLowerCase();
      if (normalizedMime && !["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/octet-stream"].includes(normalizedMime)) {
        throw new Error(`Unexpected XLSX content type: ${mimeType}`);
      }
      if (buffer.includes(Buffer.from("vbaProject.bin"))) throw new Error("Macro-enabled workbook content is not supported");
    }
    if (extension === ".csv") {
      if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) throw new Error("CSV contains binary NUL bytes");
      const normalizedMime = mimeType.toLowerCase();
      if (normalizedMime && !["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel", "application/octet-stream"].includes(normalizedMime)) {
        throw new Error(`Unexpected CSV content type: ${mimeType}`);
      }
    }
    return extension;
  }

  async parse(fileName: string, mimeType: string, buffer: Buffer): Promise<ParsedTable> {
    const extension = this.validate(fileName, mimeType, buffer);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    return extension === ".xlsx"
      ? this.parseXlsx(fileName, sha256, buffer)
      : this.parseCsv(fileName, sha256, buffer);
  }

  private async parseXlsx(fileName: string, sha256: string, buffer: Buffer): Promise<ParsedTable> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    if (!workbook.worksheets.length) throw new Error("Workbook does not contain a worksheet");
    const sheets = workbook.worksheets.map((sheet) => ({
      name: sheet.name,
      rows: Math.max(0, sheet.actualRowCount - 1),
      columns: sheet.actualColumnCount,
    }));
    const worksheet = workbook.worksheets.slice().sort((a, b) =>
      (b.actualRowCount * Math.max(1, b.actualColumnCount)) - (a.actualRowCount * Math.max(1, a.actualColumnCount))
    )[0];
    if (!worksheet) throw new Error("Workbook does not contain a readable worksheet");
    if (worksheet.actualColumnCount > this.options.maxColumns) throw new Error(`Worksheet exceeds ${this.options.maxColumns} column limit`);

    const formulaCounter = { value: 0 };
    let headerRow = 1;
    for (let rowNumber = 1; rowNumber <= Math.min(25, worksheet.actualRowCount); rowNumber += 1) {
      const candidate = rowValues(worksheet, rowNumber, worksheet.actualColumnCount, formulaCounter);
      if (nonEmptyCount(candidate) >= Math.min(2, worksheet.actualColumnCount)) { headerRow = rowNumber; break; }
    }
    const dataRows = Math.max(0, worksheet.actualRowCount - headerRow);
    if (dataRows > this.options.maxRows) throw new Error(`Worksheet exceeds ${this.options.maxRows.toLocaleString()} row limit`);
    const warnings: ReportQualityWarning[] = [];
    const headers = uniqueHeaders(rowValues(worksheet, headerRow, worksheet.actualColumnCount, formulaCounter), warnings);
    const rows: TableScalar[][] = [];
    for (let rowNumber = headerRow + 1; rowNumber <= worksheet.actualRowCount; rowNumber += 1) {
      const values = rowValues(worksheet, rowNumber, headers.length, formulaCounter);
      if (nonEmptyCount(values)) rows.push(values);
    }
    if (!rows.length) throw new Error("Selected worksheet does not contain data rows");
    if (formulaCounter.value) warnings.push({
      code: "cached_formulas",
      message: `${formulaCounter.value} formula cell(s) used cached values; Cherry never executes spreadsheet formulas.`,
      count: formulaCounter.value,
    });
    return { fileName, sha256, sheetName: worksheet.name, headers, rows, sheets, warnings };
  }

  private parseCsv(fileName: string, sha256: string, buffer: Buffer): ParsedTable {
    const decoded = buffer.toString("utf8");
    const warnings: ReportQualityWarning[] = [];
    if (decoded.includes("\ufffd")) warnings.push({ code: "encoding", message: "CSV contains invalid UTF-8 replacement characters." });
    const records = parseCsv(decoded, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      max_record_size: 2_000_000,
      to: this.options.maxRows + 2,
    }) as string[][];
    if (records.length < 2) throw new Error("CSV must contain a header row and at least one data row");
    if (records.length > this.options.maxRows + 1) throw new Error(`CSV exceeds ${this.options.maxRows.toLocaleString()} row limit`);
    const width = Math.max(...records.map((row) => row.length));
    if (width > this.options.maxColumns) throw new Error(`CSV exceeds ${this.options.maxColumns} column limit`);
    const headers = uniqueHeaders(Array.from({ length: width }, (_, index) => records[0]?.[index] ?? ""), warnings);
    const rows = records.slice(1).map((row) => headers.map((_, index) => {
      const value = row[index]?.trim() ?? "";
      return value === "" ? null : value;
    }));
    return {
      fileName,
      sha256,
      sheetName: "CSV",
      headers,
      rows,
      sheets: [{ name: "CSV", rows: rows.length, columns: headers.length }],
      warnings,
    };
  }
}
