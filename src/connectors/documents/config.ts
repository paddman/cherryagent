import type { BidPilotConfig } from "./BidPilotEngine.js";

function integerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const bidPilotConfig: BidPilotConfig = {
  pdfToTextBin: process.env.CHERRY_BIDPILOT_PDFTOTEXT_BIN?.trim() || "pdftotext",
  pdfToPpmBin: process.env.CHERRY_BIDPILOT_PDFTOPPM_BIN?.trim() || "pdftoppm",
  tesseractBin: process.env.CHERRY_BIDPILOT_TESSERACT_BIN?.trim() || "tesseract",
  ocrLanguages: process.env.CHERRY_BIDPILOT_OCR_LANGUAGES?.trim() || "tha+eng",
  maxOcrPages: Math.min(100, Math.max(1, integerEnv("CHERRY_BIDPILOT_MAX_OCR_PAGES", 30))),
  timeoutMs: Math.max(5_000, integerEnv("CHERRY_BIDPILOT_TIMEOUT_MS", 120_000)),
  maxDocumentBytes: Math.max(1_000_000, integerEnv("CHERRY_BIDPILOT_MAX_DOCUMENT_BYTES", 25_000_000)),
};
