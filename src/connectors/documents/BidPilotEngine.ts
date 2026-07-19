import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type BidPilotConfig = {
  pdfToTextBin: string;
  pdfToPpmBin: string;
  tesseractBin: string;
  ocrLanguages: string;
  maxOcrPages: number;
  timeoutMs: number;
  maxDocumentBytes: number;
};

export type RequirementCategory =
  | "qualification"
  | "technical"
  | "commercial"
  | "delivery"
  | "legal"
  | "security"
  | "other";

export type BidRequirement = {
  id: string;
  sourcePage: number;
  sourceRef: string;
  section: string;
  text: string;
  category: RequirementCategory;
  mandatory: boolean;
  evidenceNeeded: string[];
  status: "unreviewed";
};

export type ComplianceStatus = "evidence_found" | "partial" | "missing" | "manual_review";

export type ComplianceRow = BidRequirement & {
  complianceStatus: ComplianceStatus;
  confidence: number;
  evidenceSource: string | null;
  evidenceSnippet: string | null;
  matchedTerms: string[];
  reviewerNote: string;
};

export type ComplianceMatrix = {
  projectName: string;
  organizationName: string;
  generatedAt: string;
  disclaimer: string;
  evidenceFiles: string[];
  rows: ComplianceRow[];
  summary: Record<ComplianceStatus, number>;
};

type DocumentExtraction = {
  sourcePath: string;
  outputPath: string;
  format: string;
  method: "text" | "pdftotext" | "ocr";
  characters: number;
  pagesProcessed: number | null;
  warnings: string[];
  verified: boolean;
};

type RequirementBundle = {
  projectName: string;
  sourcePath: string;
  generatedAt: string;
  requirements: BidRequirement[];
  warnings: string[];
};

type Paragraph = {
  page: number;
  text: string;
};

type EvidenceDocument = {
  path: string;
  text: string;
  normalized: string;
};

const mandatoryPattern = /(ต้อง|จะต้อง|กำหนดให้|ผู้เสนอราคา|ผู้ยื่นข้อเสนอ|ห้าม|ไม่น้อยกว่า|ไม่ต่ำกว่า|ไม่เกิน|ภายใน|shall\b|must\b|required\b|at least\b|no more than\b)/i;
const bulletPattern = /^(?:\d+(?:\.\d+){0,6}|[ก-ฮ]|[a-z])(?:[.)]|\s)|^[-•*]\s+/i;
const headingPattern = /^(?:หมวด|ส่วนที่|บทที่|หัวข้อ|chapter|section|part)\b/i;
const disclaimer = "การจับคู่หลักฐานเป็นการช่วยคัดกรองเบื้องต้น ไม่ใช่คำยืนยันว่าผ่านข้อกำหนด ต้องให้ผู้รับผิดชอบตรวจและอนุมัติก่อนใช้ยื่นข้อเสนอ";

function normalizeText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/g, ""))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function normalizeForSearch(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("th-TH").replace(/\s+/g, " ").trim();
}

function safeSlug(value: string): string {
  const slug = value
    .normalize("NFKC")
    .toLocaleLowerCase("th-TH")
    .replace(/[^a-z0-9ก-๙]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "bid-project";
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function isUsefulText(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 200) return false;
  const letters = compact.match(/[A-Za-zก-๙]/g)?.length ?? 0;
  return letters / compact.length >= 0.2;
}

function paragraphsFromText(text: string): Paragraph[] {
  const result: Paragraph[] = [];
  const pages = text.split("\f");

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const pageText = pages[pageIndex] ?? "";
    let current = "";
    const flush = (): void => {
      const cleaned = current.replace(/\s+/g, " ").trim();
      if (cleaned) result.push({ page: pageIndex + 1, text: cleaned });
      current = "";
    };

    for (const rawLine of pageText.split("\n")) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!line) {
        flush();
        continue;
      }

      const startsBlock = bulletPattern.test(line) || headingPattern.test(line);
      if (startsBlock && current) flush();
      if (current && current.length + line.length > 1_500) flush();
      current = current ? `${current} ${line}` : line;
    }
    flush();
  }

  return result;
}

function requirementCategory(text: string): RequirementCategory {
  const value = normalizeForSearch(text);
  if (/(คุณสมบัติ|ประสบการณ์|ผลงาน|หนังสือรับรอง|ใบอนุญาต|certificate|qualification|experience)/i.test(value)) return "qualification";
  if (/(ราคา|งบประมาณ|ค่าบริการ|boq|quotation|price|payment|commercial)/i.test(value)) return "commercial";
  if (/(ส่งมอบ|ระยะเวลา|ภายใน.*วัน|sla|delivery|timeline|maintenance|รับประกัน)/i.test(value)) return "delivery";
  if (/(สัญญา|กฎหมาย|ข้อสงวนสิทธิ์|ค่าปรับ|ลิขสิทธิ์|contract|legal|penalty|liability)/i.test(value)) return "legal";
  if (/(ความมั่นคงปลอดภัย|ข้อมูลส่วนบุคคล|pdpa|iso 27001|security|encryption|audit log|access control)/i.test(value)) return "security";
  if (/(สเปก|คุณลักษณะเฉพาะ|ระบบ|อุปกรณ์|ซอฟต์แวร์|ฮาร์ดแวร์|api|technical|specification|performance)/i.test(value)) return "technical";
  return "other";
}

function evidenceNeeded(category: RequirementCategory): string[] {
  switch (category) {
    case "qualification": return ["หนังสือรับรองบริษัท", "หลักฐานผลงานหรือคุณสมบัติ"];
    case "technical": return ["Product datasheet", "Technical specification หรือ architecture"];
    case "commercial": return ["BOQ หรือใบเสนอราคา", "เงื่อนไขการชำระเงิน"];
    case "delivery": return ["Project plan", "SLA แผนส่งมอบหรือรับประกัน"];
    case "legal": return ["เอกสารสัญญาหรือข้อกฎหมาย", "หนังสือมอบอำนาจเมื่อเกี่ยวข้อง"];
    case "security": return ["Security policy/certificate", "หลักฐานการควบคุมและ audit"];
    case "other": return ["หลักฐานที่ผู้รับผิดชอบระบุหลังตรวจข้อกำหนด"];
  }
}

function isHeading(text: string): boolean {
  if (text.length < 3 || text.length > 140) return false;
  if (headingPattern.test(text)) return true;
  if (mandatoryPattern.test(text)) return false;
  return bulletPattern.test(text) && text.length < 90 && !/[.?!:]$/.test(text);
}

function extractKeywords(text: string): string[] {
  const normalized = normalizeForSearch(text);
  const found: string[] = [];
  const stopWords = new Set([
    "และ", "หรือ", "ของ", "ให้", "ต้อง", "จะต้อง", "เป็น", "โดย", "ที่", "ใน", "จาก", "กับ", "the", "and", "for", "with", "shall", "must", "required",
  ]);

  for (const token of normalized.match(/[a-z0-9][a-z0-9._/-]{2,}/g) ?? []) {
    if (token.length >= 4 && !stopWords.has(token)) found.push(token);
  }

  for (const thaiRun of normalized.match(/[ก-๙]{4,}/g) ?? []) {
    if (!stopWords.has(thaiRun)) found.push(thaiRun);
    const limit = Math.min(thaiRun.length - 3, 24);
    for (let index = 0; index < limit; index += 3) {
      found.push(thaiRun.slice(index, index + 4));
    }
  }

  return [...new Set(found)].slice(0, 30);
}

function evidenceSnippet(document: EvidenceDocument, term: string): string {
  const index = document.normalized.indexOf(term);
  if (index < 0) return document.text.slice(0, 320).replace(/\s+/g, " ").trim();
  const start = Math.max(0, index - 120);
  const end = Math.min(document.normalized.length, index + term.length + 220);
  return document.normalized.slice(start, end).trim();
}

function matrixMarkdown(matrix: ComplianceMatrix): string {
  const lines = [
    `# Compliance Matrix — ${matrix.projectName}`,
    "",
    `องค์กร: ${matrix.organizationName}`,
    `สร้างเมื่อ: ${matrix.generatedAt}`,
    "",
    `> ${matrix.disclaimer}`,
    "",
    `สรุป: evidence_found=${matrix.summary.evidence_found}, partial=${matrix.summary.partial}, missing=${matrix.summary.missing}, manual_review=${matrix.summary.manual_review}`,
    "",
    "| ID | หน้า/อ้างอิง | หมวด | ข้อกำหนด | สถานะ | ความมั่นใจ | หลักฐาน | หมายเหตุผู้ตรวจ |",
    "|---|---|---|---|---|---:|---|---|",
  ];

  for (const row of matrix.rows) {
    lines.push(`| ${row.id} | ${row.sourceRef.replace(/\|/g, "\\|")} | ${row.category} | ${row.text.replace(/\|/g, "\\|")} | ${row.complianceStatus} | ${Math.round(row.confidence * 100)}% | ${(row.evidenceSource ?? "").replace(/\|/g, "\\|")} | ${row.reviewerNote.replace(/\|/g, "\\|")} |`);
  }

  return `${lines.join("\n")}\n`;
}

function matrixCsv(matrix: ComplianceMatrix): string {
  const rows: unknown[][] = [[
    "id", "source_page", "source_ref", "section", "category", "mandatory", "requirement", "compliance_status", "confidence", "evidence_source", "evidence_snippet", "matched_terms", "reviewer_note",
  ]];
  for (const row of matrix.rows) {
    rows.push([
      row.id,
      row.sourcePage,
      row.sourceRef,
      row.section,
      row.category,
      row.mandatory,
      row.text,
      row.complianceStatus,
      row.confidence.toFixed(3),
      row.evidenceSource,
      row.evidenceSnippet,
      row.matchedTerms.join("; "),
      row.reviewerNote,
    ]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export class BidPilotEngine {
  constructor(private readonly config: BidPilotConfig) {}

  private sandboxPath(workspaceRoot: string, requested: string): string {
    if (!requested.trim()) throw new Error("path must be a non-empty string");
    const root = resolve(workspaceRoot);
    const target = resolve(root, requested);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error("Path escapes the configured workspace sandbox");
    }
    return target;
  }

  private relativePath(workspaceRoot: string, absolutePath: string): string {
    return relative(resolve(workspaceRoot), absolutePath).split(sep).join("/");
  }

  private async readWorkspaceText(workspaceRoot: string, requested: string): Promise<string> {
    const target = this.sandboxPath(workspaceRoot, requested);
    const info = await stat(target);
    if (!info.isFile()) throw new Error(`${requested} is not a file`);
    if (info.size > this.config.maxDocumentBytes) {
      throw new Error(`Document exceeds ${this.config.maxDocumentBytes} byte limit`);
    }
    return normalizeText(await readFile(target, "utf8"));
  }

  private async run(command: string, args: string[], maxBuffer = this.config.maxDocumentBytes): Promise<{ stdout: string; stderr: string }> {
    try {
      const result = await execFileAsync(command, args, {
        timeout: this.config.timeoutMs,
        maxBuffer,
        encoding: "utf8",
        windowsHide: true,
      });
      return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Command failed (${command}): ${detail}`);
    }
  }

  private async extractPdfWithOcr(source: string): Promise<{ text: string; pages: number }> {
    const temporary = await mkdtemp(resolve(tmpdir(), "cherry-bidpilot-"));
    try {
      const prefix = resolve(temporary, "page");
      await this.run(this.config.pdfToPpmBin, [
        "-f", "1",
        "-l", String(this.config.maxOcrPages),
        "-r", "160",
        "-png",
        source,
        prefix,
      ], 4_000_000);

      const images = (await readdir(temporary))
        .filter((name) => name.toLowerCase().endsWith(".png"))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (!images.length) throw new Error("OCR renderer produced no page images");

      const pages: string[] = [];
      for (const image of images.slice(0, this.config.maxOcrPages)) {
        const result = await this.run(this.config.tesseractBin, [
          resolve(temporary, image),
          "stdout",
          "-l", this.config.ocrLanguages,
          "--psm", "6",
        ]);
        pages.push(normalizeText(result.stdout));
      }
      return { text: pages.join("\n\f\n"), pages: pages.length };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async extractDocument(input: {
    workspaceRoot: string;
    path: string;
    outputPath?: string;
    ocr?: boolean;
  }): Promise<DocumentExtraction> {
    const source = this.sandboxPath(input.workspaceRoot, input.path);
    const info = await stat(source);
    if (!info.isFile()) throw new Error(`${input.path} is not a file`);
    if (info.size > this.config.maxDocumentBytes) {
      throw new Error(`Document exceeds ${this.config.maxDocumentBytes} byte limit`);
    }

    const extension = extname(source).toLowerCase();
    const outputRelative = input.outputPath ?? `.bidpilot/extracted/${safeSlug(basename(source, extension))}.txt`;
    const output = this.sandboxPath(input.workspaceRoot, outputRelative);
    const warnings: string[] = [];
    let text = "";
    let method: DocumentExtraction["method"] = "text";
    let pagesProcessed: number | null = null;

    if ([".txt", ".md", ".csv", ".json", ".xml", ".html"].includes(extension)) {
      text = normalizeText(await readFile(source, "utf8"));
    } else if (extension === ".pdf") {
      try {
        const result = await this.run(this.config.pdfToTextBin, ["-layout", "-enc", "UTF-8", source, "-"]);
        text = normalizeText(result.stdout);
        method = "pdftotext";
        if (result.stderr.trim()) warnings.push(result.stderr.trim().slice(0, 500));
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }

      if (!isUsefulText(text)) {
        if (input.ocr === false) {
          throw new Error("PDF has insufficient embedded text. Re-run with ocr=true and install pdftoppm + tesseract with Thai/English language data.");
        }
        const ocr = await this.extractPdfWithOcr(source);
        text = normalizeText(ocr.text);
        method = "ocr";
        pagesProcessed = ocr.pages;
        warnings.push("Embedded text was insufficient; OCR fallback was used.");
      }
    } else {
      throw new Error(`Unsupported document format: ${extension || "unknown"}. Supported: PDF, TXT, MD, CSV, JSON, XML, HTML.`);
    }

    if (!text) throw new Error("No text could be extracted from the document");
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, text, "utf8");
    const verified = (await readFile(output, "utf8")) === text;

    return {
      sourcePath: this.relativePath(input.workspaceRoot, source),
      outputPath: this.relativePath(input.workspaceRoot, output),
      format: extension || "text",
      method,
      characters: text.length,
      pagesProcessed,
      warnings,
      verified,
    };
  }

  async extractRequirements(input: {
    workspaceRoot: string;
    textPath: string;
    outputPath?: string;
    projectName?: string;
  }): Promise<{ outputPath: string; count: number; categories: Record<RequirementCategory, number>; warnings: string[]; verified: boolean }> {
    const text = await this.readWorkspaceText(input.workspaceRoot, input.textPath);
    const paragraphs = paragraphsFromText(text);
    const requirements: BidRequirement[] = [];
    let section = "General";

    for (const paragraph of paragraphs) {
      if (isHeading(paragraph.text)) {
        section = paragraph.text;
        continue;
      }
      const candidate = mandatoryPattern.test(paragraph.text) || (bulletPattern.test(paragraph.text) && paragraph.text.length >= 35);
      if (!candidate || paragraph.text.length < 20) continue;
      const category = requirementCategory(paragraph.text);
      requirements.push({
        id: `REQ-${String(requirements.length + 1).padStart(3, "0")}`,
        sourcePage: paragraph.page,
        sourceRef: `หน้า ${paragraph.page}${section !== "General" ? ` · ${section}` : ""}`,
        section,
        text: paragraph.text,
        category,
        mandatory: mandatoryPattern.test(paragraph.text),
        evidenceNeeded: evidenceNeeded(category),
        status: "unreviewed",
      });
      if (requirements.length >= 1_000) break;
    }

    const warnings: string[] = [];
    if (!requirements.length) warnings.push("ไม่พบข้อกำหนดด้วยกฎเบื้องต้น ควรตรวจรูปแบบข้อความหรือใช้ Agent/LLM ช่วยจำแนกจาก extracted text");
    if (requirements.length >= 1_000) warnings.push("หยุดที่ 1,000 ข้อกำหนดตาม safety limit");

    const projectName = input.projectName?.trim() || basename(input.textPath, extname(input.textPath));
    const outputRelative = input.outputPath ?? `.bidpilot/requirements/${safeSlug(projectName)}.requirements.json`;
    const output = this.sandboxPath(input.workspaceRoot, outputRelative);
    const bundle: RequirementBundle = {
      projectName,
      sourcePath: input.textPath,
      generatedAt: new Date().toISOString(),
      requirements,
      warnings,
    };
    await mkdir(dirname(output), { recursive: true });
    const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
    await writeFile(output, serialized, "utf8");

    const categories: Record<RequirementCategory, number> = {
      qualification: 0,
      technical: 0,
      commercial: 0,
      delivery: 0,
      legal: 0,
      security: 0,
      other: 0,
    };
    for (const requirement of requirements) categories[requirement.category] += 1;

    return {
      outputPath: this.relativePath(input.workspaceRoot, output),
      count: requirements.length,
      categories,
      warnings,
      verified: (await readFile(output, "utf8")) === serialized,
    };
  }

  async createComplianceMatrix(input: {
    workspaceRoot: string;
    requirementsPath: string;
    evidencePaths?: string[];
    outputBasePath?: string;
    projectName?: string;
    organizationName?: string;
  }): Promise<{ jsonPath: string; csvPath: string; markdownPath: string; summary: ComplianceMatrix["summary"]; verified: boolean }> {
    const raw = await this.readWorkspaceText(input.workspaceRoot, input.requirementsPath);
    const parsed = JSON.parse(raw) as Partial<RequirementBundle>;
    if (!Array.isArray(parsed.requirements)) throw new Error("requirementsPath does not contain a valid requirement bundle");
    const requirements = parsed.requirements as BidRequirement[];

    const evidenceDocuments: EvidenceDocument[] = [];
    for (const evidencePath of input.evidencePaths ?? []) {
      const text = await this.readWorkspaceText(input.workspaceRoot, evidencePath);
      evidenceDocuments.push({ path: evidencePath, text, normalized: normalizeForSearch(text) });
    }

    const rows: ComplianceRow[] = requirements.map((requirement) => {
      const terms = extractKeywords(requirement.text);
      let best: { document: EvidenceDocument; matched: string[]; score: number } | null = null;
      for (const document of evidenceDocuments) {
        const matched = terms.filter((term) => document.normalized.includes(term));
        const denominator = Math.max(1, Math.min(terms.length, 20));
        const score = Math.min(1, matched.length / denominator);
        if (!best || score > best.score) best = { document, matched, score };
      }

      let complianceStatus: ComplianceStatus = "manual_review";
      if (evidenceDocuments.length && best) {
        complianceStatus = best.score >= 0.6 ? "evidence_found" : best.score >= 0.2 ? "partial" : "missing";
      }

      return {
        ...requirement,
        complianceStatus,
        confidence: Number((best?.score ?? 0).toFixed(3)),
        evidenceSource: best && best.score > 0 ? best.document.path : null,
        evidenceSnippet: best && best.score > 0 && best.matched[0] ? evidenceSnippet(best.document, best.matched[0]) : null,
        matchedTerms: best?.matched.slice(0, 12) ?? [],
        reviewerNote: complianceStatus === "evidence_found"
          ? "พบข้อความที่เกี่ยวข้อง โปรดตรวจว่าเป็นหลักฐานฉบับปัจจุบันและตรงทุกเงื่อนไข"
          : complianceStatus === "partial"
            ? "พบหลักฐานบางส่วน ต้องเติมข้อมูลหรือขอเอกสารเพิ่ม"
            : complianceStatus === "missing"
              ? "ยังไม่พบหลักฐานในชุดเอกสารที่ให้มา"
              : "ยังไม่ได้แนบหลักฐาน ต้องตรวจโดยผู้รับผิดชอบ",
      };
    });

    const summary: ComplianceMatrix["summary"] = { evidence_found: 0, partial: 0, missing: 0, manual_review: 0 };
    for (const row of rows) summary[row.complianceStatus] += 1;

    const projectName = input.projectName?.trim() || parsed.projectName || basename(input.requirementsPath, extname(input.requirementsPath));
    const organizationName = input.organizationName?.trim() || "ยังไม่ระบุองค์กรผู้ยื่นข้อเสนอ";
    const matrix: ComplianceMatrix = {
      projectName,
      organizationName,
      generatedAt: new Date().toISOString(),
      disclaimer,
      evidenceFiles: evidenceDocuments.map((document) => document.path),
      rows,
      summary,
    };

    const baseRelative = input.outputBasePath ?? `.bidpilot/matrix/${safeSlug(projectName)}.compliance`;
    const jsonPath = this.sandboxPath(input.workspaceRoot, `${baseRelative}.json`);
    const csvPath = this.sandboxPath(input.workspaceRoot, `${baseRelative}.csv`);
    const markdownPath = this.sandboxPath(input.workspaceRoot, `${baseRelative}.md`);
    await mkdir(dirname(jsonPath), { recursive: true });
    const jsonContent = `${JSON.stringify(matrix, null, 2)}\n`;
    const csvContent = matrixCsv(matrix);
    const markdownContent = matrixMarkdown(matrix);
    await Promise.all([
      writeFile(jsonPath, jsonContent, "utf8"),
      writeFile(csvPath, csvContent, "utf8"),
      writeFile(markdownPath, markdownContent, "utf8"),
    ]);

    const verified = (await readFile(jsonPath, "utf8")) === jsonContent
      && (await readFile(csvPath, "utf8")) === csvContent
      && (await readFile(markdownPath, "utf8")) === markdownContent;

    return {
      jsonPath: this.relativePath(input.workspaceRoot, jsonPath),
      csvPath: this.relativePath(input.workspaceRoot, csvPath),
      markdownPath: this.relativePath(input.workspaceRoot, markdownPath),
      summary,
      verified,
    };
  }

  async generateProposal(input: {
    workspaceRoot: string;
    matrixPath: string;
    outputPath?: string;
    projectName?: string;
    customerName?: string;
    bidderName?: string;
  }): Promise<{ outputPath: string; requirements: number; verified: boolean }> {
    const raw = await this.readWorkspaceText(input.workspaceRoot, input.matrixPath);
    const matrix = JSON.parse(raw) as ComplianceMatrix;
    if (!Array.isArray(matrix.rows)) throw new Error("matrixPath does not contain a valid compliance matrix");
    const projectName = input.projectName?.trim() || matrix.projectName;
    const bidderName = input.bidderName?.trim() || matrix.organizationName;
    const customerName = input.customerName?.trim() || "หน่วยงานลูกค้า";
    const outputRelative = input.outputPath ?? `.bidpilot/proposals/${safeSlug(projectName)}.proposal.md`;
    const output = this.sandboxPath(input.workspaceRoot, outputRelative);

    const lines = [
      `# ร่างข้อเสนอทางเทคนิค: ${projectName}`,
      "",
      `ผู้ยื่นข้อเสนอ: ${bidderName}`,
      `ลูกค้า/หน่วยงาน: ${customerName}`,
      `วันที่จัดทำร่าง: ${new Date().toISOString()}`,
      "",
      `> ${disclaimer}`,
      "",
      "## 1. Executive Summary",
      "",
      "[ให้ผู้รับผิดชอบสรุปปัญหา เป้าหมาย ผลลัพธ์ และเหตุผลที่แนวทางของเราตอบโจทย์โครงการนี้]",
      "",
      "## 2. ความเข้าใจต่อโครงการ",
      "",
      "[สรุปขอบเขต งานส่งมอบ ผู้มีส่วนเกี่ยวข้อง และข้อจำกัดสำคัญจาก TOR/RFP]",
      "",
      "## 3. แนวทางและสถาปัตยกรรมที่เสนอ",
      "",
      "[อธิบาย solution architecture, workflow, integration, security และแผนรองรับการขยายระบบ]",
      "",
      "## 4. ตารางตอบข้อกำหนด",
      "",
      "| ID | ข้อกำหนด | คำตอบ/แนวทาง | หลักฐาน | สถานะตรวจ |",
      "|---|---|---|---|---|",
    ];

    for (const row of matrix.rows) {
      lines.push(`| ${row.id} | ${row.text.replace(/\|/g, "\\|")} | [ร่างคำตอบโดยทีม Presales/Technical] | ${(row.evidenceSource ?? "[ต้องแนบ]").replace(/\|/g, "\\|")} | ${row.complianceStatus} |`);
    }

    lines.push(
      "",
      "## 5. แผนดำเนินงานและส่งมอบ",
      "",
      "[ระบุ milestone, owner, dependency, acceptance criteria, SLA และแผน rollback]",
      "",
      "## 6. การบริหารความเสี่ยง",
      "",
      "[ระบุความเสี่ยงด้านเทคนิค กฎหมาย ข้อมูล ความปลอดภัย บุคลากร และแผนลดความเสี่ยง]",
      "",
      "## 7. สมมติฐานและคำถามที่ต้องขอความชัดเจน",
      "",
      ...matrix.rows.filter((row) => row.complianceStatus !== "evidence_found").map((row) => `- ${row.id}: ${row.reviewerNote}`),
      "",
      "## 8. Approval Checklist ก่อนยื่น",
      "",
      "- [ ] Bid Manager ตรวจความครบถ้วนของ TOR และ amendment ล่าสุด",
      "- [ ] Technical Owner ยืนยันว่าคำตอบตรงสเปกและทำได้จริง",
      "- [ ] Legal/Commercial ตรวจสัญญา ราคา ภาษี และค่าปรับ",
      "- [ ] Security/PDPA ตรวจข้อกำหนดข้อมูลและการเข้าถึง",
      "- [ ] ผู้มีอำนาจอนุมัติเอกสารฉบับสุดท้าย",
      "",
    );

    const content = `${lines.join("\n")}\n`;
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, content, "utf8");
    return {
      outputPath: this.relativePath(input.workspaceRoot, output),
      requirements: matrix.rows.length,
      verified: (await readFile(output, "utf8")) === content,
    };
  }

  async runPipeline(input: {
    workspaceRoot: string;
    sourcePath: string;
    evidencePaths?: string[];
    outputDir?: string;
    projectName?: string;
    organizationName?: string;
    customerName?: string;
    ocr?: boolean;
  }): Promise<Record<string, unknown>> {
    const projectName = input.projectName?.trim() || basename(input.sourcePath, extname(input.sourcePath));
    const outputDir = input.outputDir ?? `.bidpilot/runs/${new Date().toISOString().replace(/[:.]/g, "-")}-${safeSlug(projectName)}`;
    const extracted = await this.extractDocument({
      workspaceRoot: input.workspaceRoot,
      path: input.sourcePath,
      outputPath: `${outputDir}/source.txt`,
      ...(input.ocr === undefined ? {} : { ocr: input.ocr }),
    });
    const requirements = await this.extractRequirements({
      workspaceRoot: input.workspaceRoot,
      textPath: extracted.outputPath,
      outputPath: `${outputDir}/requirements.json`,
      projectName,
    });

    const evidenceTextPaths: string[] = [];
    for (const evidencePath of input.evidencePaths ?? []) {
      const extension = extname(evidencePath).toLowerCase();
      if ([".txt", ".md", ".csv", ".json", ".xml", ".html"].includes(extension)) {
        evidenceTextPaths.push(evidencePath);
      } else {
        const extractedEvidence = await this.extractDocument({
          workspaceRoot: input.workspaceRoot,
          path: evidencePath,
          outputPath: `${outputDir}/evidence/${safeSlug(basename(evidencePath, extension))}.txt`,
          ...(input.ocr === undefined ? {} : { ocr: input.ocr }),
        });
        evidenceTextPaths.push(extractedEvidence.outputPath);
      }
    }

    const matrix = await this.createComplianceMatrix({
      workspaceRoot: input.workspaceRoot,
      requirementsPath: requirements.outputPath,
      evidencePaths: evidenceTextPaths,
      outputBasePath: `${outputDir}/compliance-matrix`,
      projectName,
      ...(input.organizationName ? { organizationName: input.organizationName } : {}),
    });
    const proposal = await this.generateProposal({
      workspaceRoot: input.workspaceRoot,
      matrixPath: matrix.jsonPath,
      outputPath: `${outputDir}/proposal-draft.md`,
      projectName,
      ...(input.organizationName ? { bidderName: input.organizationName } : {}),
      ...(input.customerName ? { customerName: input.customerName } : {}),
    });

    const manifestPath = this.sandboxPath(input.workspaceRoot, `${outputDir}/manifest.json`);
    const manifest = {
      projectName,
      generatedAt: new Date().toISOString(),
      source: extracted,
      requirements,
      matrix,
      proposal,
      evidenceTextPaths,
      disclaimer,
    };
    const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, manifestContent, "utf8");

    return {
      outputDir,
      manifestPath: this.relativePath(input.workspaceRoot, manifestPath),
      ...manifest,
      verified: (await readFile(manifestPath, "utf8")) === manifestContent,
    };
  }
}
