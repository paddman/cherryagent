import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { Document, HeadingLevel, Packer, Paragraph } from "docx";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { PDFParse } from "pdf-parse";
import PptxGenJSModule from "pptxgenjs";
import JSZip from "jszip";
import type { AgentTool, ToolContext } from "../../core/types.js";
import { sandboxPath } from "./files.js";

// pptxgenjs's CJS/ESM interop shape differs across the plain Node loader (real ESM default
// export) and esbuild-based runtimes like tsx (wraps as { default: PptxGenJS }); detect either.
const PptxGenJS = (
  typeof PptxGenJSModule === "function"
    ? PptxGenJSModule
    : (PptxGenJSModule as unknown as { default: unknown }).default
) as new () => InstanceType<typeof import("pptxgenjs").default>;

const PDF_PAGE_WIDTH = 612;
const PDF_PAGE_HEIGHT = 792;
const PDF_MARGIN = 54;
const PDF_FONT_SIZE = 11;
const PDF_LINE_HEIGHT = 16;

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value.trim();
}

function requiredStringArray(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value;
}

function wrapLine(font: { widthOfTextAtSize: (text: string, size: number) => number }, text: string, maxWidth: number, size: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function readWorkspaceFile(context: ToolContext, path: unknown): Promise<{ target: string; bytes: Buffer }> {
  const target = sandboxPath(context, path);
  return { target, bytes: await readFile(target) };
}

async function writeWorkspaceFile(context: ToolContext, path: unknown, bytes: Uint8Array): Promise<{ target: string; relativePath: string }> {
  const target = sandboxPath(context, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return { target, relativePath: relative(context.workspaceRoot, target) };
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function extractPptxSlideText(bytes: Buffer): Promise<Array<{ index: number; text: string }>> {
  const zip = await JSZip.loadAsync(bytes);
  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
      const nb = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
      return na - nb;
    });

  const slides: Array<{ index: number; text: string }> = [];
  for (const [index, path] of slidePaths.entries()) {
    const xml = await zip.file(path)?.async("string");
    const runs = [...(xml ?? "").matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXmlEntities(match[1] ?? ""));
    slides.push({ index, text: runs.join(" ").trim() });
  }
  return slides;
}

export const documentTools: AgentTool[] = [
  {
    name: "documents_create_pdf",
    description: "Create a new PDF file in the workspace sandbox from a list of paragraphs, with automatic word-wrap and pagination.",
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative output path, for example reports/summary.pdf" },
        title: { type: "string", description: "Optional title rendered as the first line" },
        paragraphs: { type: "array", items: { type: "string" }, description: "Body paragraphs in order" },
      },
      required: ["path", "paragraphs"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const paragraphs = requiredStringArray(args, "paragraphs");
      const title = optionalString(args, "title");
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
      const maxWidth = PDF_PAGE_WIDTH - PDF_MARGIN * 2;

      let page = doc.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT]);
      let cursorY = PDF_PAGE_HEIGHT - PDF_MARGIN;

      const drawLine = (text: string, useFont: typeof font, size: number) => {
        if (cursorY < PDF_MARGIN) {
          page = doc.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT]);
          cursorY = PDF_PAGE_HEIGHT - PDF_MARGIN;
        }
        page.drawText(text, { x: PDF_MARGIN, y: cursorY, size, font: useFont });
        cursorY -= PDF_LINE_HEIGHT;
      };

      if (title) {
        for (const line of wrapLine(boldFont, title, maxWidth, 16)) drawLine(line, boldFont, 16);
        cursorY -= PDF_LINE_HEIGHT / 2;
      }
      for (const paragraph of paragraphs) {
        for (const line of wrapLine(font, paragraph, maxWidth, PDF_FONT_SIZE)) drawLine(line, font, PDF_FONT_SIZE);
        cursorY -= PDF_LINE_HEIGHT / 2;
      }

      const bytes = await doc.save();
      const written = await writeWorkspaceFile(context, args.path, bytes);
      return { path: written.relativePath, bytes: bytes.length, pageCount: doc.getPageCount(), verified: true };
    },
  },
  {
    name: "documents_append_pdf_page",
    description: "Append a new page of paragraphs to an existing PDF file in the workspace sandbox.",
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative existing PDF path" },
        paragraphs: { type: "array", items: { type: "string" }, description: "Body paragraphs for the new page" },
      },
      required: ["path", "paragraphs"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const paragraphs = requiredStringArray(args, "paragraphs");
      const { bytes: existing } = await readWorkspaceFile(context, args.path);
      const doc = await PDFDocument.load(existing);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const maxWidth = PDF_PAGE_WIDTH - PDF_MARGIN * 2;

      let page = doc.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT]);
      let cursorY = PDF_PAGE_HEIGHT - PDF_MARGIN;
      for (const paragraph of paragraphs) {
        for (const line of wrapLine(font, paragraph, maxWidth, PDF_FONT_SIZE)) {
          if (cursorY < PDF_MARGIN) {
            page = doc.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT]);
            cursorY = PDF_PAGE_HEIGHT - PDF_MARGIN;
          }
          page.drawText(line, { x: PDF_MARGIN, y: cursorY, size: PDF_FONT_SIZE, font });
          cursorY -= PDF_LINE_HEIGHT;
        }
        cursorY -= PDF_LINE_HEIGHT / 2;
      }

      const bytes = await doc.save();
      const written = await writeWorkspaceFile(context, args.path, bytes);
      return { path: written.relativePath, bytes: bytes.length, pageCount: doc.getPageCount(), verified: true };
    },
  },
  {
    name: "documents_read_pdf",
    description: "Extract plain text and page count from a PDF file in the workspace sandbox.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative PDF path" } },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const { target, bytes } = await readWorkspaceFile(context, args.path);
      const parser = new PDFParse({ data: bytes });
      try {
        const result = await parser.getText();
        return {
          path: relative(context.workspaceRoot, target),
          pageCount: result.pages?.length ?? undefined,
          text: result.text.slice(0, 100_000),
          truncated: result.text.length > 100_000,
          verified: true,
        };
      } finally {
        await parser.destroy();
      }
    },
  },
  {
    name: "documents_create_docx",
    description: "Create a new Word (.docx) file in the workspace sandbox from a title and a list of paragraphs.",
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative output path, for example reports/summary.docx" },
        title: { type: "string", description: "Optional heading rendered at the top of the document" },
        paragraphs: { type: "array", items: { type: "string" }, description: "Body paragraphs in order" },
      },
      required: ["path", "paragraphs"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const paragraphs = requiredStringArray(args, "paragraphs");
      const title = optionalString(args, "title");
      const children: Paragraph[] = [];
      if (title) children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }));
      for (const paragraph of paragraphs) children.push(new Paragraph({ text: paragraph }));

      const doc = new Document({ sections: [{ children }] });
      const bytes = await Packer.toBuffer(doc);
      const written = await writeWorkspaceFile(context, args.path, bytes);
      return { path: written.relativePath, bytes: bytes.length, verified: true };
    },
  },
  {
    name: "documents_read_docx",
    description: "Extract plain text from a Word (.docx) file in the workspace sandbox.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative .docx path" } },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const { target, bytes } = await readWorkspaceFile(context, args.path);
      const result = await mammoth.extractRawText({ buffer: bytes });
      return {
        path: relative(context.workspaceRoot, target),
        text: result.value.slice(0, 100_000),
        truncated: result.value.length > 100_000,
        verified: true,
      };
    },
  },
  {
    name: "documents_create_xlsx",
    description: "Create a new Excel (.xlsx) workbook in the workspace sandbox with one sheet of rows. Cells may be plain values or {\"formula\":\"SUM(A1:A5)\"} objects.",
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative output path, for example reports/data.xlsx" },
        sheetName: { type: "string", description: "Sheet name, defaults to Sheet1" },
        rows: {
          type: "array",
          items: { type: "array", items: {} },
          description: "Row-major 2D array of cell values, or {\"formula\": string} objects for formulas",
        },
      },
      required: ["path", "rows"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const rows = args.rows;
      if (!Array.isArray(rows) || !rows.every((row) => Array.isArray(row))) {
        throw new Error("rows must be a 2D array");
      }
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet(optionalString(args, "sheetName") ?? "Sheet1");
      for (const row of rows as unknown[][]) {
        sheet.addRow(
          row.map((cell) =>
            cell && typeof cell === "object" && "formula" in cell
              ? { formula: String((cell as { formula: unknown }).formula) }
              : (cell as ExcelJS.CellValue),
          ),
        );
      }

      const bytes = await workbook.xlsx.writeBuffer();
      const written = await writeWorkspaceFile(context, args.path, new Uint8Array(bytes));
      return { path: written.relativePath, sheetName: sheet.name, rowCount: sheet.rowCount, verified: true };
    },
  },
  {
    name: "documents_read_xlsx",
    description: "Read cell values from a sheet in an Excel (.xlsx) workbook in the workspace sandbox.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative .xlsx path" },
        sheetName: { type: "string", description: "Sheet name; defaults to the first sheet" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const { target, bytes } = await readWorkspaceFile(context, args.path);
      const workbook = new ExcelJS.Workbook();
      // `any` sidesteps a structural Buffer mismatch caused by conflicting @types/node
      // versions pulled in transitively by other document-format dependencies.
      await workbook.xlsx.load(bytes as any);
      const sheetName = optionalString(args, "sheetName");
      const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
      if (!sheet) throw new Error(sheetName ? `Sheet "${sheetName}" was not found` : "Workbook has no sheets");

      const values: unknown[][] = [];
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const cells = (row.values as unknown[]).slice(1);
        values.push(
          cells.map((cell) => {
            if (cell && typeof cell === "object" && "formula" in cell) {
              const formulaCell = cell as { formula?: string; result?: unknown };
              return { formula: formulaCell.formula, result: formulaCell.result };
            }
            return cell ?? null;
          }),
        );
      });

      return { path: relative(context.workspaceRoot, target), sheetName: sheet.name, rows: values, verified: true };
    },
  },
  {
    name: "documents_update_xlsx_range",
    description: "Write cell values starting at a given cell in an existing Excel (.xlsx) workbook, creating the sheet if needed. Requires an existing file created by documents_create_xlsx or another tool.",
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative .xlsx path" },
        sheetName: { type: "string", description: "Sheet name, defaults to Sheet1" },
        startCell: { type: "string", description: "Top-left cell of the write range, for example B2" },
        values: {
          type: "array",
          items: { type: "array", items: {} },
          description: "Row-major 2D array of cell values, or {\"formula\": string} objects for formulas",
        },
      },
      required: ["path", "startCell", "values"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const values = args.values;
      if (!Array.isArray(values) || !values.every((row) => Array.isArray(row))) {
        throw new Error("values must be a 2D array");
      }
      const startCell = requiredString(args, "startCell");
      const match = /^([A-Za-z]+)(\d+)$/.exec(startCell);
      if (!match) throw new Error("startCell must look like A1, B2, etc.");
      const startCol = match[1] as string;
      const startRow = Number(match[2]);

      const target = sandboxPath(context, args.path);
      const workbook = new ExcelJS.Workbook();
      let existing = true;
      try {
        await workbook.xlsx.readFile(target);
      } catch {
        existing = false;
      }
      const sheetName = optionalString(args, "sheetName") ?? "Sheet1";
      const sheet = workbook.getWorksheet(sheetName) ?? workbook.addWorksheet(sheetName);

      (values as unknown[][]).forEach((row, rowOffset) => {
        row.forEach((cell, colOffset) => {
          const cellRef = sheet.getCell(startRow + rowOffset, columnLetterToNumber(startCol) + colOffset);
          cellRef.value =
            cell && typeof cell === "object" && "formula" in cell
              ? { formula: String((cell as { formula: unknown }).formula) }
              : (cell as ExcelJS.CellValue);
        });
      });

      const bytes = await workbook.xlsx.writeBuffer();
      const written = await writeWorkspaceFile(context, args.path, new Uint8Array(bytes));
      return { path: written.relativePath, sheetName, createdFile: !existing, verified: true };
    },
  },
  {
    name: "documents_create_pptx",
    description: "Create a new PowerPoint (.pptx) file in the workspace sandbox from a list of title-and-body slides.",
    risk: "write",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative output path, for example reports/deck.pptx" },
        slides: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              body: { type: "string" },
            },
            required: ["title"],
            additionalProperties: false,
          },
          description: "Ordered list of slides, each with a title and optional body text",
        },
      },
      required: ["path", "slides"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const slidesInput = args.slides;
      if (!Array.isArray(slidesInput) || slidesInput.length === 0) {
        throw new Error("slides must be a non-empty array");
      }

      const pptx = new PptxGenJS();
      for (const raw of slidesInput) {
        if (!raw || typeof raw !== "object") throw new Error("Each slide must be an object");
        const slideData = raw as { title?: unknown; body?: unknown };
        if (typeof slideData.title !== "string" || !slideData.title.trim()) {
          throw new Error("Each slide requires a non-empty title");
        }
        const slide = pptx.addSlide();
        slide.addText(slideData.title, { x: 0.5, y: 0.4, w: 9, h: 1, fontSize: 28, bold: true });
        if (typeof slideData.body === "string" && slideData.body.trim()) {
          slide.addText(slideData.body, { x: 0.5, y: 1.6, w: 9, h: 4.5, fontSize: 16 });
        }
      }

      const output = await pptx.write({ outputType: "nodebuffer" });
      const bytes = output instanceof Uint8Array ? output : Buffer.from(output as ArrayBuffer);
      const written = await writeWorkspaceFile(context, args.path, bytes);
      return { path: written.relativePath, bytes: bytes.length, slideCount: slidesInput.length, verified: true };
    },
  },
  {
    name: "documents_read_pptx",
    description: "Extract per-slide plain text from a PowerPoint (.pptx) file in the workspace sandbox.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative .pptx path" } },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const { target, bytes } = await readWorkspaceFile(context, args.path);
      const slides = await extractPptxSlideText(bytes);
      return { path: relative(context.workspaceRoot, target), slideCount: slides.length, slides, verified: true };
    },
  },
];

function columnLetterToNumber(letters: string): number {
  let result = 0;
  for (const char of letters.toUpperCase()) {
    result = result * 26 + (char.charCodeAt(0) - 64);
  }
  return result;
}
