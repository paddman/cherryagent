import { basename, resolve, sep } from "node:path";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { AgenticStateStore, AgentTask } from "../agentic/AgenticStateStore.js";
import type { LlmProvider } from "../core/types.js";
import { ReportAnalyzer } from "./ReportAnalyzer.js";
import { ReportPdfRenderer } from "./ReportPdfRenderer.js";
import { ReportStore } from "./ReportStore.js";
import { TabularParser } from "./TabularParser.js";
import { salesSampleCsv } from "./sampleData.js";
import type { ParsedTable, ReportMapping, ReportRecord, ReportSnapshot, ReportStatus, ReportTemplate } from "./types.js";

export type ReportStudioOptions = {
  workspaceRoot: string;
  retentionDays: number;
  maxBytes: number;
  maxRows: number;
  maxColumns: number;
  modelTimeoutMs?: number;
};

const taskSpecs = [
  { key: "ingest", role: "office" as const, objective: "Validate and ingest the uploaded table with a cryptographic source fingerprint", dependsOn: [] },
  { key: "profile", role: "research" as const, objective: "Profile sheet shape, columns, missing values, and cached formulas", dependsOn: ["ingest"] },
  { key: "analyze", role: "research" as const, objective: "Compute deterministic KPI, aggregate trends, quality warnings, and aggregate-only narrative", dependsOn: ["profile"] },
  { key: "visualize", role: "office" as const, objective: "Create verified native chart specifications and persist the report artifact", dependsOn: ["analyze"] },
  { key: "pdf", role: "office" as const, objective: "Render a downloadable Thai PDF with embedded fonts", dependsOn: ["visualize"] },
  { key: "verify", role: "verifier" as const, objective: "Verify report JSON, PDF signature, source SHA-256, and generated evidence", dependsOn: ["pdf"] },
];

function safeFileName(value: string): string {
  const name = basename(value).replace(/[^a-zA-Z0-9ก-๙._ -]+/g, "-").slice(0, 140).trim();
  return name || "report.csv";
}

function publicRecord(record: ReportRecord): Omit<ReportRecord, "sourcePath" | "reportPath" | "pdfPath"> {
  const { sourcePath: _sourcePath, reportPath: _reportPath, pdfPath: _pdfPath, ...visible } = record;
  return visible;
}

export class ReportStudioService {
  readonly parser: TabularParser;
  readonly analyzer: ReportAnalyzer;
  readonly pdf = new ReportPdfRenderer();

  constructor(
    readonly store: ReportStore,
    private readonly agentic: AgenticStateStore,
    provider: LlmProvider,
    private readonly options: ReportStudioOptions,
  ) {
    this.parser = new TabularParser(options);
    this.analyzer = new ReportAnalyzer(provider, options.modelTimeoutMs ?? 25_000);
  }

  validateUpload(fileName: string, mimeType: string, buffer: Buffer): ".xlsx" | ".csv" {
    return this.parser.validate(safeFileName(fileName), mimeType, buffer);
  }

  async create(input: { tenantId: string; fileName: string; mimeType: string; buffer: Buffer; template?: ReportTemplate; title?: string }): Promise<ReportRecord> {
    const fileName = safeFileName(input.fileName);
    const extension = this.validateUpload(fileName, input.mimeType, input.buffer);
    const id = crypto.randomUUID();
    const directory = this.reportDirectory(input.tenantId, id);
    await mkdir(directory, { recursive: true });
    const sourcePath = resolve(directory, `source${extension}`);
    await writeFile(sourcePath, input.buffer, { mode: 0o600 });
    const run = await this.agentic.createRun(`Create a verified report from ${fileName}`, { tenantId: input.tenantId, tags: ["report-studio", "excel-report", `template:${input.template ?? "auto"}`] });
    await this.agentic.addTasks(run.id, taskSpecs);
    const now = new Date();
    const record: ReportRecord = {
      id,
      tenantId: input.tenantId,
      runId: run.id,
      title: input.title?.trim() || fileName.replace(/\.[^.]+$/, ""),
      fileName,
      mimeType: input.mimeType || (extension === ".csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
      extension,
      template: input.template ?? "auto",
      status: "queued",
      phase: "queued",
      progress: 0,
      sourcePath,
      reportPath: resolve(directory, "report.json"),
      pdfPath: resolve(directory, "report.pdf"),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.options.retentionDays * 86_400_000).toISOString(),
    };
    await this.store.create(record);
    void this.execute(record.id, record.tenantId);
    return record;
  }

  async createSample(tenantId: string): Promise<ReportRecord> {
    return this.create({ tenantId, fileName: "cherry-sales-sample.csv", mimeType: "text/csv", buffer: salesSampleCsv(), template: "sales", title: "Cherry Sales Performance" });
  }

  async regenerate(id: string, tenantId: string, mapping: ReportMapping): Promise<ReportRecord> {
    const existing = await this.store.get(id, tenantId);
    if (existing.status === "running" || existing.status === "queued") throw new Error("Report is already running");
    const run = await this.agentic.createRun(`Regenerate report ${existing.title} with updated mapping`, { tenantId, tags: ["report-studio", "regenerate"] });
    await this.agentic.addTasks(run.id, taskSpecs);
    const updated = await this.store.update(id, tenantId, {
      runId: run.id,
      mapping,
      status: "queued",
      phase: "queued",
      progress: 0,
      error: undefined,
      warning: undefined,
      completedAt: undefined,
    });
    void this.execute(id, tenantId);
    return updated;
  }

  async get(id: string, tenantId: string): Promise<ReportSnapshot> {
    const record = await this.store.get(id, tenantId);
    let report: ReportSnapshot["report"];
    try { report = JSON.parse(await readFile(record.reportPath, "utf8")) as ReportSnapshot["report"]; } catch { report = undefined; }
    return { ...publicRecord(record), ...(report ? { report } : {}) };
  }

  async list(tenantId: string, limit = 50): Promise<Array<Omit<ReportRecord, "sourcePath" | "reportPath" | "pdfPath">>> {
    return (await this.store.list(tenantId, limit)).map(publicRecord);
  }

  async pdfPath(id: string, tenantId: string): Promise<{ path: string; fileName: string }> {
    const record = await this.store.get(id, tenantId);
    if (record.status !== "succeeded" && record.status !== "degraded") throw new Error("Report PDF is not ready");
    const info = await stat(record.pdfPath);
    if (!info.isFile() || info.size < 100) throw new Error("Report PDF is not ready");
    return { path: record.pdfPath, fileName: `${record.title.replace(/[^a-zA-Z0-9ก-๙._ -]+/g, "-")}.pdf` };
  }

  async remove(id: string, tenantId: string): Promise<void> {
    const record = await this.store.get(id, tenantId);
    if (record.status === "running" || record.status === "queued") throw new Error("Cannot delete a running report");
    const directory = this.reportDirectory(tenantId, id);
    await this.store.remove(id, tenantId);
    await rm(directory, { recursive: true, force: true });
  }

  async pruneExpired(): Promise<number> {
    const expired = (await this.store.expired()).filter((record) => record.status !== "running" && record.status !== "queued");
    for (const record of expired) {
      await this.store.remove(record.id, record.tenantId);
      await rm(this.reportDirectory(record.tenantId, record.id), { recursive: true, force: true });
    }
    return expired.length;
  }

  async recoverInterrupted(): Promise<number> {
    let recovered = 0;
    for (const record of await this.store.active()) {
      try {
        const run = await this.agentic.getRun(record.runId, record.tenantId);
        if (run.status === "running") continue;
        await this.store.update(record.id, record.tenantId, {
          status: "failed",
          phase: "failed",
          error: "Report generation was interrupted by a server restart. Adjust the mapping or upload the source again to regenerate it.",
          completedAt: new Date().toISOString(),
        });
        recovered += 1;
      } catch {
        await this.store.update(record.id, record.tenantId, {
          status: "failed",
          phase: "failed",
          error: "Report execution trail is unavailable after a server restart.",
          completedAt: new Date().toISOString(),
        });
        recovered += 1;
      }
    }
    return recovered;
  }

  private reportDirectory(tenantId: string, reportId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(tenantId) || !/^[a-f0-9-]{36}$/i.test(reportId)) throw new Error("Invalid report storage identity");
    const tenantRoot = resolve(this.options.workspaceRoot, tenantId, "reports");
    const target = resolve(tenantRoot, reportId);
    if (!target.startsWith(`${tenantRoot}${sep}`)) throw new Error("Report path escapes tenant workspace");
    return target;
  }

  private async execute(id: string, tenantId: string): Promise<void> {
    let record = await this.store.get(id, tenantId);
    const run = await this.agentic.getRun(record.runId, tenantId);
    const tasks = new Map(run.tasks.map((task) => [task.key, task]));
    let active: AgentTask | undefined;
    try {
      record = await this.store.update(id, tenantId, { status: "running", phase: "ingest", progress: 2 });
      active = this.requireTask(tasks, "ingest");
      await this.startTask(run.id, active, 1, "report_parse");
      const source = await readFile(record.sourcePath);
      const table = await this.parser.parse(record.fileName, record.mimeType, source);
      await this.agentic.publishEvidence({ runId: run.id, taskId: active.id, agent: active.role, kind: "fact", claim: `Source ${record.fileName} verified as SHA-256 ${table.sha256}`, data: { sha256: table.sha256, sheetName: table.sheetName, rows: table.rows.length, columns: table.headers.length }, sourceTool: "report_parse", confidence: 1 });
      await this.finishTask(run.id, active, `Ingested ${table.rows.length} rows from ${table.sheetName}`);

      active = this.requireTask(tasks, "profile");
      await this.store.update(id, tenantId, { phase: "profile", progress: 22, sha256: table.sha256, rowCount: table.rows.length, columnCount: table.headers.length, sheetName: table.sheetName });
      await this.startTask(run.id, active, 2, "report_profile");
      await this.agentic.publishEvidence({ runId: run.id, taskId: active.id, agent: active.role, kind: "observation", claim: `Profiled ${table.headers.length} columns without executing spreadsheet formulas`, data: { headers: table.headers, warnings: table.warnings, sheets: table.sheets }, sourceTool: "report_profile", confidence: 1 });
      await this.finishTask(run.id, active, `Profiled ${table.headers.length} columns`);

      active = this.requireTask(tasks, "analyze");
      await this.store.update(id, tenantId, { phase: "analyze", progress: 42 });
      await this.startTask(run.id, active, 3, "report_analyze");
      const analysis = await this.analyzer.analyze(table, record.template, record.mapping);
      await this.agentic.publishEvidence({ runId: run.id, taskId: active.id, agent: active.role, kind: "tool_result", claim: `Computed ${analysis.report.kpis.length} KPI and ${analysis.report.insights.length} evidence-linked insights`, data: { kpis: analysis.report.kpis, mapping: analysis.report.mapping, modelEnhanced: analysis.report.modelEnhanced }, sourceTool: "report_analyze", confidence: 1 });
      await this.finishTask(run.id, active, analysis.degradedReason ?? "Deterministic analysis and aggregate-only narrative completed");

      active = this.requireTask(tasks, "visualize");
      await this.store.update(id, tenantId, { phase: "visualize", progress: 63, mapping: analysis.report.mapping, modelEnhanced: analysis.report.modelEnhanced, ...(analysis.degradedReason ? { warning: analysis.degradedReason } : {}) });
      await this.startTask(run.id, active, 4, "report_visualize");
      const reportTemp = `${record.reportPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await writeFile(reportTemp, JSON.stringify(analysis.report, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      await rename(reportTemp, record.reportPath);
      await this.agentic.publishEvidence({ runId: run.id, taskId: active.id, agent: active.role, kind: "fact", claim: `Persisted ${analysis.report.charts.length} native chart specifications`, data: { charts: analysis.report.charts.map((chart) => ({ id: chart.id, type: chart.type, points: chart.labels.length, sourceColumns: chart.sourceColumns })) }, sourceTool: "report_visualize", confidence: 1 });
      await this.finishTask(run.id, active, `Created ${analysis.report.charts.length} charts`);

      active = this.requireTask(tasks, "pdf");
      await this.store.update(id, tenantId, { phase: "pdf", progress: 79 });
      await this.startTask(run.id, active, 5, "report_pdf");
      await this.pdf.render(analysis.report, record.pdfPath);
      const pdfInfo = await stat(record.pdfPath);
      await this.agentic.publishEvidence({ runId: run.id, taskId: active.id, agent: active.role, kind: "tool_result", claim: `Rendered downloadable PDF (${pdfInfo.size} bytes) with embedded Thai fonts`, data: { bytes: pdfInfo.size }, sourceTool: "report_pdf", confidence: 1 });
      await this.finishTask(run.id, active, `Rendered ${pdfInfo.size} byte PDF`);

      active = this.requireTask(tasks, "verify");
      await this.store.update(id, tenantId, { phase: "verify", progress: 92 });
      await this.startTask(run.id, active, 6, "report_verify");
      await this.verifyArtifacts(record, table);
      await this.agentic.publishEvidence({ runId: run.id, taskId: active.id, agent: active.role, kind: "verification", claim: "Verified report JSON, PDF signature, row/column counts, and source SHA-256", data: { reportId: id, sha256: table.sha256, rows: table.rows.length, columns: table.headers.length }, sourceTool: "report_verify", confidence: 1 });
      await this.finishTask(run.id, active, "All report artifacts verified");

      const status: ReportStatus = analysis.degradedReason ? "degraded" : "succeeded";
      await this.store.update(id, tenantId, { status, phase: "complete", progress: 100, completedAt: new Date().toISOString() });
      await this.agentic.setRunVerification(run.id, { verdict: "pass", confidence: 100, reportId: id, sourceSha256: table.sha256, modelEnhanced: analysis.report.modelEnhanced });
      await this.agentic.completeRun(run.id, { status: "succeeded", synthesis: `Report ${id} completed as ${status} with ${analysis.report.kpis.length} KPI, ${analysis.report.charts.length} charts, and a verified PDF.` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (active) await this.agentic.updateTask(run.id, active.id, { status: "failed", error: message, completedAt: new Date().toISOString() });
      for (const task of run.tasks) {
        const current = await this.agentic.getRun(run.id, tenantId);
        const latest = current.tasks.find((item) => item.id === task.id);
        if (latest?.status === "pending") await this.agentic.updateTask(run.id, task.id, { status: "skipped", error: `Pipeline stopped: ${message}`, completedAt: new Date().toISOString() });
      }
      await this.store.update(id, tenantId, { status: "failed", phase: "failed", error: message, completedAt: new Date().toISOString() });
      await this.agentic.completeRun(run.id, { status: "failed", synthesis: `Report generation failed: ${message}` });
    }
  }

  private requireTask(tasks: Map<string, AgentTask>, key: string): AgentTask {
    const task = tasks.get(key);
    if (!task) throw new Error(`Report pipeline task missing: ${key}`);
    return task;
  }

  private async startTask(runId: string, task: AgentTask, step: number, tool: string): Promise<void> {
    await this.agentic.updateTask(runId, task.id, { status: "running", startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), progress: { step, maxSteps: 6, phase: "tool", activeTool: tool } });
  }

  private async finishTask(runId: string, task: AgentTask, result: string): Promise<void> {
    await this.agentic.updateTask(runId, task.id, { status: "succeeded", result, completedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), progress: { step: 6, maxSteps: 6, phase: "finalizing" } });
  }

  private async verifyArtifacts(record: ReportRecord, table: ParsedTable): Promise<void> {
    const persisted = JSON.parse(await readFile(record.reportPath, "utf8")) as { source?: { sha256?: string; rowCount?: number; columnCount?: number }; verified?: boolean };
    if (!persisted.verified || persisted.source?.sha256 !== table.sha256 || persisted.source.rowCount !== table.rows.length || persisted.source.columnCount !== table.headers.length) {
      throw new Error("Persisted report verification mismatch");
    }
    const signature = await readFile(record.pdfPath).then((buffer) => buffer.subarray(0, 5).toString("ascii"));
    if (signature !== "%PDF-") throw new Error("Generated PDF signature is invalid");
  }
}
