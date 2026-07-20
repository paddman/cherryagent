export type ReportTemplate = "auto" | "general" | "sales" | "finance" | "operations";
export type ResolvedReportTemplate = Exclude<ReportTemplate, "auto">;
export type ReportStatus = "queued" | "running" | "succeeded" | "degraded" | "failed";
export type ReportColumnType = "number" | "date" | "category" | "text" | "boolean" | "identifier";

export type ReportMapping = {
  dateColumn?: string;
  metrics: string[];
  dimensions: string[];
};

export type ReportColumnProfile = {
  name: string;
  type: ReportColumnType;
  nonNull: number;
  missing: number;
  unique: number;
  missingPercent: number;
  min?: number;
  max?: number;
  sum?: number;
  average?: number;
};

export type ReportKpi = {
  id: string;
  label: string;
  value: number;
  formatted: string;
  aggregation: "count" | "sum" | "average" | "missing_percent";
  sourceColumn?: string;
};

export type ReportChart = {
  id: string;
  type: "line" | "bar" | "donut";
  title: string;
  labels: string[];
  series: Array<{ name: string; values: number[] }>;
  sourceColumns: string[];
};

export type ReportInsight = {
  title: string;
  detail: string;
  severity: "info" | "positive" | "warning";
  evidence: string[];
};

export type ReportQualityWarning = {
  code: string;
  message: string;
  column?: string;
  count?: number;
};

export type ReportResult = {
  title: string;
  executiveSummary: string;
  template: ResolvedReportTemplate;
  source: {
    fileName: string;
    sha256: string;
    sheetName: string;
    rowCount: number;
    columnCount: number;
    availableSheets: Array<{ name: string; rows: number; columns: number }>;
  };
  mapping: ReportMapping;
  columns: ReportColumnProfile[];
  kpis: ReportKpi[];
  charts: ReportChart[];
  insights: ReportInsight[];
  quality: ReportQualityWarning[];
  generatedAt: string;
  verified: boolean;
  modelEnhanced: boolean;
};

export type ReportRecord = {
  id: string;
  tenantId: string;
  runId: string;
  title: string;
  fileName: string;
  mimeType: string;
  extension: ".xlsx" | ".csv";
  template: ReportTemplate;
  status: ReportStatus;
  phase: string;
  progress: number;
  sourcePath: string;
  reportPath: string;
  pdfPath: string;
  mapping?: ReportMapping;
  sha256?: string;
  rowCount?: number;
  columnCount?: number;
  sheetName?: string;
  modelEnhanced?: boolean;
  error?: string;
  warning?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  expiresAt: string;
};

export type ReportSnapshot = Omit<ReportRecord, "sourcePath" | "reportPath" | "pdfPath"> & {
  report?: ReportResult;
};

export type TableScalar = string | number | boolean | Date | null;
export type ParsedTable = {
  fileName: string;
  sha256: string;
  sheetName: string;
  headers: string[];
  rows: TableScalar[][];
  sheets: Array<{ name: string; rows: number; columns: number }>;
  warnings: ReportQualityWarning[];
};
