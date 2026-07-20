import { createWriteStream } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import PDFDocument from "pdfkit";
import type { ReportChart, ReportResult } from "./types.js";

const colors = { ink: "#10213f", soft: "#587094", blue: "#0b6cff", pale: "#eef5ff", green: "#2eb67d", amber: "#e7a23b", red: "#e45465", line: "#dfe7f5" };

function fontPath(subset: "thai" | "latin", weight: 400 | 700): string {
  return resolve(process.cwd(), `node_modules/@fontsource/noto-sans-thai/files/noto-sans-thai-${subset}-${weight}-normal.woff`);
}

function setFont(doc: PDFKit.PDFDocument, thai: boolean, bold: boolean): void {
  doc.font(thai ? (bold ? "ThaiBold" : "Thai") : (bold ? "LatinBold" : "Latin"));
}

function mixedText(
  doc: PDFKit.PDFDocument,
  value: string,
  input: { x?: number; y?: number; width?: number; size?: number; color?: string; bold?: boolean; lineGap?: number } = {},
): void {
  if (input.x !== undefined && input.y !== undefined) doc.x = input.x, doc.y = input.y;
  doc.fontSize(input.size ?? 10).fillColor(input.color ?? colors.ink);
  const segments = value.split(/([\u0E00-\u0E7F]+)/g).filter(Boolean);
  if (!segments.length) return;
  segments.forEach((segment, index) => {
    setFont(doc, /[\u0E00-\u0E7F]/.test(segment), input.bold === true);
    doc.text(segment, {
      ...(input.width ? { width: input.width } : {}),
      continued: index < segments.length - 1,
      lineGap: input.lineGap ?? 2,
    });
  });
}

function ensureSpace(doc: PDFKit.PDFDocument, required: number): void {
  if (doc.y + required > doc.page.height - 55) doc.addPage();
}

function chart(doc: PDFKit.PDFDocument, item: ReportChart): void {
  ensureSpace(doc, 190);
  mixedText(doc, item.title, { size: 13, bold: true });
  doc.moveDown(0.4);
  const labels = item.labels.slice(0, 8);
  const values = item.series[0]?.values.slice(0, 8) ?? [];
  const maximum = Math.max(1, ...values.map((value) => Math.abs(value)));
  const left = 125;
  const width = 360;
  for (let index = 0; index < labels.length; index += 1) {
    ensureSpace(doc, 22);
    const y = doc.y;
    mixedText(doc, labels[index] ?? "", { x: 45, y: y + 2, width: 72, size: 8, color: colors.soft });
    const value = values[index] ?? 0;
    const barWidth = Math.max(2, (Math.abs(value) / maximum) * width);
    doc.roundedRect(left, y + 2, barWidth, 11, 3).fill(index === 0 ? colors.blue : "#79b4ff");
    mixedText(doc, new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2 }).format(value), { x: left + barWidth + 7, y, width: 70, size: 8 });
    doc.y = y + 21;
  }
  doc.moveDown(0.5);
}

export class ReportPdfRenderer {
  async render(report: ReportResult, outputPath: string): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    const temp = `${outputPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const doc = new PDFDocument({ size: "A4", margin: 45, info: { Title: report.title, Author: "Cherry Report Studio", Subject: `Verified report for ${report.source.fileName}` } });
      doc.registerFont("Thai", fontPath("thai", 400));
      doc.registerFont("ThaiBold", fontPath("thai", 700));
      doc.registerFont("Latin", fontPath("latin", 400));
      doc.registerFont("LatinBold", fontPath("latin", 700));
      const stream = createWriteStream(temp, { mode: 0o600 });
      stream.on("finish", resolvePromise);
      stream.on("error", rejectPromise);
      doc.on("error", rejectPromise);
      doc.pipe(stream);

      doc.roundedRect(35, 30, 525, 104, 16).fill(colors.ink);
      mixedText(doc, "CHERRY REPORT STUDIO", { x: 53, y: 48, width: 485, size: 9, color: "#8fbcff", bold: true });
      mixedText(doc, report.title, { x: 53, y: 68, width: 485, size: 20, color: "#ffffff", bold: true, lineGap: 4 });
      mixedText(doc, `${report.source.fileName} • ${report.source.sheetName} • ${report.source.rowCount.toLocaleString("th-TH")} rows`, { x: 53, y: 111, width: 485, size: 8, color: "#cdddf5" });
      doc.y = 154;

      mixedText(doc, "สรุปสำหรับผู้บริหาร", { size: 15, bold: true });
      doc.moveDown(0.35);
      mixedText(doc, report.executiveSummary, { size: 10, color: colors.soft, lineGap: 4 });
      doc.moveDown(1);

      mixedText(doc, "ตัวชี้วัดหลัก", { size: 15, bold: true });
      doc.moveDown(0.5);
      const cardWidth = 118;
      report.kpis.slice(0, 4).forEach((kpi, index) => {
        const x = 45 + index * 128;
        const y = doc.y;
        doc.roundedRect(x, y, cardWidth, 65, 8).fill(colors.pale);
        mixedText(doc, kpi.label, { x: x + 10, y: y + 11, width: cardWidth - 20, size: 8, color: colors.soft });
        mixedText(doc, kpi.formatted, { x: x + 10, y: y + 34, width: cardWidth - 20, size: 15, color: colors.blue, bold: true });
      });
      doc.y += 82;

      for (const item of report.charts) chart(doc, item);

      ensureSpace(doc, 140);
      mixedText(doc, "Insight ที่ตรวจสอบย้อนกลับได้", { size: 15, bold: true });
      doc.moveDown(0.5);
      for (const insight of report.insights) {
        ensureSpace(doc, 55);
        const y = doc.y;
        const color = insight.severity === "warning" ? colors.amber : insight.severity === "positive" ? colors.green : colors.blue;
        doc.roundedRect(45, y, 5, 42, 2).fill(color);
        mixedText(doc, insight.title, { x: 60, y, width: 480, size: 10, bold: true });
        mixedText(doc, insight.detail, { x: 60, y: y + 17, width: 480, size: 8, color: colors.soft });
        doc.y = Math.max(doc.y, y + 52);
      }

      if (report.quality.length) {
        ensureSpace(doc, 90);
        mixedText(doc, "คำเตือนคุณภาพข้อมูล", { size: 14, bold: true, color: colors.red });
        doc.moveDown(0.4);
        for (const warning of report.quality.slice(0, 8)) mixedText(doc, `• ${warning.message}`, { size: 8, color: colors.soft });
      }

      ensureSpace(doc, 70);
      doc.moveTo(45, doc.y).lineTo(550, doc.y).strokeColor(colors.line).stroke();
      doc.moveDown(0.7);
      mixedText(doc, `Verified source SHA-256: ${report.source.sha256}`, { size: 7, color: colors.soft });
      mixedText(doc, `Generated ${new Date(report.generatedAt).toLocaleString("th-TH")} • ${report.modelEnhanced ? "AI narrative from aggregate only" : "Deterministic degraded mode"}`, { size: 7, color: colors.soft });
      doc.end();
    });
    await rename(temp, outputPath);
  }
}
