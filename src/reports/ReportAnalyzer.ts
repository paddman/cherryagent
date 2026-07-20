import type { LlmProvider } from "../core/types.js";
import type {
  ParsedTable,
  ReportChart,
  ReportColumnProfile,
  ReportColumnType,
  ReportInsight,
  ReportKpi,
  ReportMapping,
  ReportQualityWarning,
  ReportResult,
  ReportTemplate,
  ResolvedReportTemplate,
  TableScalar,
} from "./types.js";

type AnalysisCore = Omit<ReportResult, "executiveSummary" | "insights" | "generatedAt" | "verified" | "modelEnhanced">;

function normalizedName(value: string): string { return value.toLowerCase().replace(/[^a-z0-9ก-๙]+/g, " ").trim(); }

function numberValue(value: TableScalar): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw || !/^-?[฿$€£]?\s*[\d,.]+(?:\s*%)?$/.test(raw)) return undefined;
  const percent = raw.endsWith("%");
  const parsed = Number(raw.replace(/[฿$€£,%\s]/g, ""));
  if (!Number.isFinite(parsed)) return undefined;
  return percent ? parsed / 100 : parsed;
}

function dateValue(value: TableScalar): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!/^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s].*)?$/.test(text) && !/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(text)) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function scalarKey(value: TableScalar): string {
  if (value === null) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function identifierName(name: string): boolean {
  return /(^|\s)(id|uuid|code|sku|เลขที่|รหัส|หมายเลข)(\s|$)/i.test(normalizedName(name));
}

function inferType(name: string, values: TableScalar[]): ReportColumnType {
  const present = values.filter((value) => value !== null && scalarKey(value) !== "");
  if (!present.length) return "text";
  if (identifierName(name)) return "identifier";
  let numbers = 0;
  let dates = 0;
  let booleans = 0;
  const unique = new Set<string>();
  for (const value of present) {
    if (numberValue(value) !== undefined) numbers += 1;
    if (dateValue(value)) dates += 1;
    if (typeof value === "boolean" || (typeof value === "string" && /^(true|false|yes|no|ใช่|ไม่)$/i.test(value.trim()))) booleans += 1;
    if (unique.size <= 1000) unique.add(scalarKey(value));
  }
  if (numbers / present.length >= 0.85) return "number";
  if (dates / present.length >= 0.8) return "date";
  if (booleans / present.length >= 0.9) return "boolean";
  const categoryLimit = Math.min(200, Math.max(20, Math.round(present.length * 0.2)));
  if (unique.size <= categoryLimit) return "category";
  if (unique.size / present.length >= 0.96 && present.length > 20) return "identifier";
  return "text";
}

function profileColumn(name: string, values: TableScalar[]): ReportColumnProfile {
  const nonNullValues = values.filter((value) => value !== null && scalarKey(value) !== "");
  const missing = values.length - nonNullValues.length;
  const type = inferType(name, values);
  const profile: ReportColumnProfile = {
    name,
    type,
    nonNull: nonNullValues.length,
    missing,
    unique: new Set(nonNullValues.map(scalarKey)).size,
    missingPercent: values.length ? Number(((missing / values.length) * 100).toFixed(2)) : 0,
  };
  if (type === "number") {
    const numbers = nonNullValues.map(numberValue).filter((value): value is number => value !== undefined);
    if (numbers.length) {
      const sum = numbers.reduce((total, value) => total + value, 0);
      let minimum = numbers[0] ?? 0;
      let maximum = numbers[0] ?? 0;
      for (const value of numbers) {
        if (value < minimum) minimum = value;
        if (value > maximum) maximum = value;
      }
      profile.min = minimum;
      profile.max = maximum;
      profile.sum = sum;
      profile.average = sum / numbers.length;
    }
  }
  return profile;
}

function resolveTemplate(requested: ReportTemplate, headers: string[]): ResolvedReportTemplate {
  if (requested !== "auto") return requested;
  const names = headers.map(normalizedName).join(" ");
  if (/(sales|revenue|customer|product|order|ยอดขาย|รายได้|ลูกค้า|สินค้า|คำสั่งซื้อ)/i.test(names)) return "sales";
  if (/(expense|profit|budget|cash|account|รายจ่าย|กำไร|งบประมาณ|เงินสด|บัญชี)/i.test(names)) return "finance";
  if (/(operation|ticket|sla|duration|status|incident|การดำเนินงาน|สถานะ|ระยะเวลา)/i.test(names)) return "operations";
  return "general";
}

function autoMapping(columns: ReportColumnProfile[]): ReportMapping {
  const dateColumn = columns.find((column) => column.type === "date")?.name;
  const metrics = columns.filter((column) => column.type === "number").slice(0, 4).map((column) => column.name);
  const dimensions = columns.filter((column) => column.type === "category" || column.type === "text").slice(0, 3).map((column) => column.name);
  return { ...(dateColumn ? { dateColumn } : {}), metrics, dimensions };
}

function validateMapping(input: ReportMapping | undefined, columns: ReportColumnProfile[]): ReportMapping {
  const automatic = autoMapping(columns);
  if (!input) return automatic;
  const byName = new Map(columns.map((column) => [column.name, column]));
  const dateColumn = input.dateColumn && byName.get(input.dateColumn)?.type === "date" ? input.dateColumn : automatic.dateColumn;
  const metrics = [...new Set(input.metrics)].filter((name) => byName.get(name)?.type === "number").slice(0, 8);
  const dimensions = [...new Set(input.dimensions)].filter((name) => {
    const type = byName.get(name)?.type;
    return type === "category" || type === "text" || type === "identifier";
  }).slice(0, 5);
  return {
    ...(dateColumn ? { dateColumn } : {}),
    metrics: metrics.length ? metrics : automatic.metrics,
    dimensions: dimensions.length ? dimensions : automatic.dimensions,
  };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("th-TH", { notation: Math.abs(value) >= 1_000_000 ? "compact" : "standard", maximumFractionDigits: 2 }).format(value);
}

function buildKpis(rowCount: number, mapping: ReportMapping, profiles: ReportColumnProfile[]): ReportKpi[] {
  const byName = new Map(profiles.map((profile) => [profile.name, profile]));
  const kpis: ReportKpi[] = [{ id: "kpi-rows", label: "จำนวนรายการ", value: rowCount, formatted: formatNumber(rowCount), aggregation: "count" }];
  for (const metric of mapping.metrics.slice(0, 3)) {
    const profile = byName.get(metric);
    if (!profile || profile.sum === undefined) continue;
    kpis.push({ id: `kpi-sum-${kpis.length}`, label: `รวม ${metric}`, value: profile.sum, formatted: formatNumber(profile.sum), aggregation: "sum", sourceColumn: metric });
  }
  const missing = profiles.reduce((sum, profile) => sum + profile.missing, 0);
  const cells = Math.max(1, rowCount * profiles.length);
  const missingPercent = (missing / cells) * 100;
  kpis.push({ id: "kpi-missing", label: "ข้อมูลที่หาย", value: missingPercent, formatted: `${missingPercent.toFixed(1)}%`, aggregation: "missing_percent" });
  return kpis.slice(0, 5);
}

function aggregateBy(table: ParsedTable, groupColumn: string, metricColumn?: string, dateBucket = false): { labels: string[]; values: number[] } {
  const groupIndex = table.headers.indexOf(groupColumn);
  const metricIndex = metricColumn ? table.headers.indexOf(metricColumn) : -1;
  const buckets = new Map<string, number>();
  for (const row of table.rows) {
    const rawGroup = row[groupIndex] ?? null;
    let group = scalarKey(rawGroup) || "(ว่าง)";
    if (dateBucket) {
      const date = dateValue(rawGroup);
      if (!date) continue;
      group = date.toISOString().slice(0, 7);
    }
    const increment = metricIndex >= 0 ? numberValue(row[metricIndex] ?? null) : 1;
    if (increment === undefined) continue;
    buckets.set(group, (buckets.get(group) ?? 0) + increment);
  }
  const entries = dateBucket
    ? [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-24)
    : [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  return { labels: entries.map(([label]) => label), values: entries.map(([, value]) => value) };
}

function buildCharts(table: ParsedTable, mapping: ReportMapping): ReportChart[] {
  const charts: ReportChart[] = [];
  const metric = mapping.metrics[0];
  if (mapping.dateColumn && metric) {
    const data = aggregateBy(table, mapping.dateColumn, metric, true);
    if (data.labels.length > 1) charts.push({ id: "chart-trend", type: "line", title: `${metric} ตามเวลา`, labels: data.labels, series: [{ name: metric, values: data.values }], sourceColumns: [mapping.dateColumn, metric] });
  }
  const dimension = mapping.dimensions[0];
  if (dimension) {
    const data = aggregateBy(table, dimension, metric);
    if (data.labels.length) charts.push({ id: "chart-ranking", type: "bar", title: metric ? `${metric} แยกตาม ${dimension}` : `จำนวนรายการแยกตาม ${dimension}`, labels: data.labels, series: [{ name: metric ?? "จำนวน", values: data.values }], sourceColumns: metric ? [dimension, metric] : [dimension] });
    const counts = aggregateBy(table, dimension);
    if (counts.labels.length > 1) charts.push({ id: "chart-share", type: "donut", title: `สัดส่วน ${dimension}`, labels: counts.labels.slice(0, 6), series: [{ name: "จำนวน", values: counts.values.slice(0, 6) }], sourceColumns: [dimension] });
  }
  return charts.slice(0, 5);
}

function anomalyWarnings(table: ParsedTable, mapping: ReportMapping): ReportQualityWarning[] {
  const warnings: ReportQualityWarning[] = [];
  for (const metric of mapping.metrics) {
    const index = table.headers.indexOf(metric);
    const values = table.rows.map((row) => numberValue(row[index] ?? null)).filter((value): value is number => value !== undefined);
    if (values.length < 10) continue;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const deviation = Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length);
    if (!deviation) continue;
    const count = values.filter((value) => Math.abs(value - mean) > deviation * 3).length;
    if (count) warnings.push({ code: "numeric_anomaly", message: `${metric} มีค่าที่ต่างจากค่าเฉลี่ยเกิน 3σ จำนวน ${count} รายการ`, column: metric, count });
  }
  return warnings;
}

function deterministicInsights(core: AnalysisCore): ReportInsight[] {
  const insights: ReportInsight[] = [{ title: "ขอบเขตข้อมูล", detail: `วิเคราะห์ ${core.source.rowCount.toLocaleString("th-TH")} แถว จาก ${core.source.columnCount} คอลัมน์ ใน sheet ${core.source.sheetName}`, severity: "info", evidence: ["source-profile"] }];
  const missing = core.columns.slice().sort((a, b) => b.missingPercent - a.missingPercent)[0];
  if (missing && missing.missingPercent > 0) insights.push({ title: "คุณภาพข้อมูล", detail: `${missing.name} มีข้อมูลว่าง ${missing.missingPercent.toFixed(1)}% ควรตรวจสอบก่อนใช้ตัดสินใจ`, severity: missing.missingPercent > 20 ? "warning" : "info", evidence: ["kpi-missing"] });
  const ranking = core.charts.find((chart) => chart.id === "chart-ranking");
  if (ranking?.labels[0] && ranking.series[0]?.values[0] !== undefined) insights.push({ title: "กลุ่มที่มีสัดส่วนสูงสุด", detail: `${ranking.labels[0]} มีค่า ${formatNumber(ranking.series[0].values[0])} สูงสุดในมุมมองนี้`, severity: "positive", evidence: [ranking.id] });
  const trend = core.charts.find((chart) => chart.id === "chart-trend");
  const values = trend?.series[0]?.values ?? [];
  if (trend && values.length >= 2) {
    const first = values[0] ?? 0;
    const last = values.at(-1) ?? 0;
    const change = first ? ((last - first) / Math.abs(first)) * 100 : 0;
    insights.push({ title: "แนวโน้ม", detail: `${trend.title} เปลี่ยนแปลง ${change >= 0 ? "+" : ""}${change.toFixed(1)}% จากช่วงแรกถึงช่วงล่าสุด`, severity: change >= 0 ? "positive" : "warning", evidence: [trend.id] });
  }
  return insights.slice(0, 6);
}

function extractJson(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Report analyst did not return JSON");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Report analyst returned invalid JSON");
  return parsed as Record<string, unknown>;
}

export class ReportAnalyzer {
  constructor(private readonly provider: LlmProvider, private readonly modelTimeoutMs = 25_000) {}

  async analyze(table: ParsedTable, requestedTemplate: ReportTemplate, requestedMapping?: ReportMapping): Promise<{ report: ReportResult; degradedReason?: string }> {
    const columns = table.headers.map((name, index) => profileColumn(name, table.rows.map((row) => row[index] ?? null)));
    const mapping = validateMapping(requestedMapping, columns);
    const template = resolveTemplate(requestedTemplate, table.headers);
    const quality = [
      ...table.warnings,
      ...columns.filter((column) => column.missingPercent >= 10).map((column) => ({ code: "missing_values", message: `${column.name} มีข้อมูลว่าง ${column.missingPercent.toFixed(1)}%`, column: column.name, count: column.missing })),
      ...anomalyWarnings(table, mapping),
    ];
    const core: AnalysisCore = {
      title: `${template === "general" ? "Data" : template[0]?.toUpperCase() + template.slice(1)} Report — ${table.fileName.replace(/\.[^.]+$/, "")}`,
      template,
      source: { fileName: table.fileName, sha256: table.sha256, sheetName: table.sheetName, rowCount: table.rows.length, columnCount: table.headers.length, availableSheets: table.sheets },
      mapping,
      columns,
      kpis: buildKpis(table.rows.length, mapping, columns),
      charts: buildCharts(table, mapping),
      quality,
    };
    const fallbackInsights = deterministicInsights(core);
    const fallbackSummary = `รายงานนี้วิเคราะห์ ${table.rows.length.toLocaleString("th-TH")} รายการ และสร้าง KPI ${core.kpis.length} ตัว พร้อมกราฟ ${core.charts.length} รายการจากข้อมูลที่คำนวณบน private server`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`Report narrative exceeded ${this.modelTimeoutMs} ms timeout`)), this.modelTimeoutMs);
    try {
      const safePayload = {
        template,
        source: { rowCount: core.source.rowCount, columnCount: core.source.columnCount, sheetName: core.source.sheetName },
        columns: columns.map((column) => ({ name: column.name, type: column.type, missingPercent: column.missingPercent, unique: column.unique })),
        kpis: core.kpis.map((kpi) => ({ id: kpi.id, label: kpi.label, value: kpi.value, aggregation: kpi.aggregation })),
        charts: core.charts.map((chart) => ({ id: chart.id, type: chart.type, title: chart.title, pointCount: chart.labels.length, values: chart.series.map((series) => series.values) })),
        quality: quality.map((item) => ({ code: item.code, column: item.column, count: item.count })),
      };
      const completion = await this.provider.complete({
        messages: [
          { role: "system", content: "You are Cherry Report Analyst. Use only supplied aggregate evidence. Never invent values. Return compact JSON only." },
          { role: "user", content: `เขียน executive summary ภาษาไทยและ insight ไม่เกิน 4 ข้อจาก aggregate ต่อไปนี้ ห้ามอ้างข้อมูลดิบ รูปแบบ {"executiveSummary":"...","insights":[{"title":"...","detail":"...","severity":"info|positive|warning","evidence":["kpi/chart id"]}]}\n${JSON.stringify(safePayload)}` },
        ],
        tools: [],
        signal: controller.signal,
      });
      const payload = extractJson(completion.message.content ?? "");
      const knownEvidence = new Set([...core.kpis.map((item) => item.id), ...core.charts.map((item) => item.id), "source-profile"]);
      const modelInsights = Array.isArray(payload.insights) ? payload.insights.flatMap((value): ReportInsight[] => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const item = value as Record<string, unknown>;
        if (typeof item.title !== "string" || typeof item.detail !== "string") return [];
        const evidence = Array.isArray(item.evidence) ? item.evidence.filter((entry): entry is string => typeof entry === "string" && knownEvidence.has(entry)) : [];
        if (!evidence.length) return [];
        const severity = item.severity === "positive" || item.severity === "warning" ? item.severity : "info";
        return [{ title: item.title.trim().slice(0, 120), detail: item.detail.trim().slice(0, 800), severity, evidence }];
      }).slice(0, 4) : [];
      const executiveSummary = typeof payload.executiveSummary === "string" && payload.executiveSummary.trim() ? payload.executiveSummary.trim().slice(0, 1600) : fallbackSummary;
      return { report: { ...core, executiveSummary, insights: modelInsights.length ? modelInsights : fallbackInsights, generatedAt: new Date().toISOString(), verified: true, modelEnhanced: true } };
    } catch (error) {
      return {
        report: { ...core, executiveSummary: fallbackSummary, insights: fallbackInsights, generatedAt: new Date().toISOString(), verified: true, modelEnhanced: false },
        degradedReason: `AI narrative unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
