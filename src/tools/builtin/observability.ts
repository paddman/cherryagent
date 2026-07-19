import type { ObservabilityClient } from "../../connectors/observability/ObservabilityClient.js";
import type { AgentTool } from "../../core/types.js";

export type AiClusterHealthConfig = {
  gpuUtilQuery: string;
  gpuTempQuery: string;
  gpuXidQuery: string;
  errorRateQuery: string;
  targetDownQuery: string;
  restartQuery: string;
  lowGpuUtilThreshold: number;
  highGpuTempThreshold: number;
  highErrorRateThreshold: number;
  highRestartThreshold: number;
};

type Severity = "ok" | "info" | "warning" | "critical" | "unavailable";

type PrometheusSample = {
  metric: Record<string, string>;
  value: number;
};

type HealthCheckResult = {
  id: string;
  label: string;
  query: string;
  severity: Severity;
  observed: number | null;
  threshold: number;
  comparator: "gt" | "lt";
  samples: PrometheusSample[];
  detail: string;
  recommendedActions: string[];
};

type CheckDefinition = {
  id: string;
  label: string;
  query: string;
  comparator: "gt" | "lt";
  threshold: number;
  aggregate: "max" | "sum";
  triggeredSeverity: "warning" | "critical";
  recommendedActions: string[];
  enabled: boolean;
};

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected non-empty string argument: ${key}`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${key} must be a finite number`);
  return number;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be boolean`);
  return value;
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetric(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") output[key] = item;
  }
  return output;
}

function numericValue(value: unknown): number | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const parsed = Number(value[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function prometheusSamples(payload: unknown): PrometheusSample[] {
  if (!isRecord(payload)) return [];
  const result = payload.result;

  if (Array.isArray(result) && result.length >= 2 && !isRecord(result[0])) {
    const scalar = numericValue(result);
    return scalar === null ? [] : [{ metric: {}, value: scalar }];
  }

  if (!Array.isArray(result)) return [];
  const samples: PrometheusSample[] = [];
  for (const item of result) {
    if (!isRecord(item)) continue;
    const value = numericValue(item.value);
    if (value === null) continue;
    samples.push({ metric: parseMetric(item.metric), value });
  }
  return samples;
}

function aggregateSamples(samples: PrometheusSample[], aggregate: "max" | "sum"): number | null {
  if (!samples.length) return null;
  if (aggregate === "sum") return samples.reduce((total, sample) => total + sample.value, 0);
  return Math.max(...samples.map((sample) => sample.value));
}

function severityRank(severity: Severity): number {
  switch (severity) {
    case "critical": return 4;
    case "warning": return 3;
    case "unavailable": return 2;
    case "info": return 1;
    case "ok": return 0;
  }
}

function substituteLookback(query: string, lookbackMinutes: number): string {
  return query.replaceAll("{{lookback}}", `${lookbackMinutes}m`);
}

async function executeCheck(client: ObservabilityClient, definition: CheckDefinition): Promise<HealthCheckResult> {
  if (!definition.enabled || !definition.query.trim()) {
    return {
      id: definition.id,
      label: definition.label,
      query: definition.query,
      severity: "info",
      observed: null,
      threshold: definition.threshold,
      comparator: definition.comparator,
      samples: [],
      detail: "Check skipped by request or configuration.",
      recommendedActions: [],
    };
  }

  try {
    const payload = await client.prometheusQuery(definition.query);
    const samples = prometheusSamples(payload);
    const observed = aggregateSamples(samples, definition.aggregate);
    if (observed === null) {
      return {
        id: definition.id,
        label: definition.label,
        query: definition.query,
        severity: "unavailable",
        observed: null,
        threshold: definition.threshold,
        comparator: definition.comparator,
        samples: [],
        detail: "Prometheus returned no numeric samples. Verify metric names and scrape targets.",
        recommendedActions: ["Verify the PromQL expression and exporter availability before taking corrective action."],
      };
    }

    const triggered = definition.comparator === "gt"
      ? observed > definition.threshold
      : observed < definition.threshold;

    return {
      id: definition.id,
      label: definition.label,
      query: definition.query,
      severity: triggered ? definition.triggeredSeverity : "ok",
      observed,
      threshold: definition.threshold,
      comparator: definition.comparator,
      samples: samples.slice(0, 50),
      detail: triggered
        ? `${definition.label} breached threshold: observed ${observed}, expected ${definition.comparator === "gt" ? "<=" : ">="} ${definition.threshold}.`
        : `${definition.label} is within threshold: observed ${observed}.`,
      recommendedActions: triggered ? definition.recommendedActions : [],
    };
  } catch (error) {
    return {
      id: definition.id,
      label: definition.label,
      query: definition.query,
      severity: "unavailable",
      observed: null,
      threshold: definition.threshold,
      comparator: definition.comparator,
      samples: [],
      detail: error instanceof Error ? error.message : String(error),
      recommendedActions: ["Restore observability access or correct the query before making infrastructure changes."],
    };
  }
}

export function createObservabilityTools(
  client: ObservabilityClient,
  healthConfig: AiClusterHealthConfig,
): AgentTool[] {
  return [
    {
      name: "observability_get_status",
      description: "Check whether Prometheus and Grafana are configured for local read-only infrastructure observability.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => client.status(),
    },
    {
      name: "prometheus_query",
      description: "Run one read-only Prometheus instant PromQL query against the configured local Prometheus server.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "PromQL expression" },
          time: { type: "string", description: "Optional RFC3339 time or Unix timestamp" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (args) => client.prometheusQuery(requiredString(args, "query"), optionalString(args, "time")),
    },
    {
      name: "prometheus_query_range",
      description: "Run one read-only Prometheus range query for trend, baseline and anomaly analysis.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          start: { type: "string", description: "RFC3339 time or Unix timestamp" },
          end: { type: "string", description: "RFC3339 time or Unix timestamp" },
          step: { type: "string", description: "Prometheus duration such as 60s or numeric seconds" },
        },
        required: ["query", "start", "end", "step"],
        additionalProperties: false,
      },
      execute: async (args) => client.prometheusQueryRange({
        query: requiredString(args, "query"),
        start: requiredString(args, "start"),
        end: requiredString(args, "end"),
        step: requiredString(args, "step"),
      }),
    },
    {
      name: "prometheus_list_alerts",
      description: "Read current Prometheus alert states, labels and annotations for incident triage.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => client.prometheusAlerts(),
    },
    {
      name: "grafana_health",
      description: "Read Grafana API health for connectivity verification.",
      risk: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => client.grafanaHealth(),
    },
    {
      name: "grafana_search",
      description: "Search Grafana dashboards and folders by title, tag or object type.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          tag: { type: "string" },
          type: { type: "string", enum: ["dash-db", "dash-folder"] },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const typeValue = optionalString(args, "type");
        const type = typeValue === "dash-db" || typeValue === "dash-folder" ? typeValue : undefined;
        return await client.grafanaSearch({
          ...(optionalString(args, "query") ? { query: optionalString(args, "query") } : {}),
          ...(optionalString(args, "tag") ? { tag: optionalString(args, "tag") } : {}),
          ...(type ? { type } : {}),
        });
      },
    },
    {
      name: "grafana_annotations",
      description: "Read Grafana annotations to correlate incidents with deployments, maintenance and operator changes.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          from: { type: "number", description: "Start time in epoch milliseconds" },
          to: { type: "number", description: "End time in epoch milliseconds" },
          tags: { type: "array", items: { type: "string" } },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
      execute: async (args) => client.grafanaAnnotations({
        ...(optionalNumber(args, "from") !== undefined ? { from: optionalNumber(args, "from") } : {}),
        ...(optionalNumber(args, "to") !== undefined ? { to: optionalNumber(args, "to") } : {}),
        ...(optionalStringArray(args, "tags") ? { tags: optionalStringArray(args, "tags") } : {}),
        ...(optionalNumber(args, "limit") !== undefined ? { limit: optionalNumber(args, "limit") } : {}),
      }),
    },
    {
      name: "ops_ai_cluster_health_check",
      description: "Run a read-only AI cluster health assessment using Prometheus. It checks target availability, GPU XID errors, GPU temperature, inference error rate, workload restarts and optional low GPU utilization, then proposes actions without executing them.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          lookbackMinutes: { type: "number", description: "Lookback used in configured PromQL templates; default 60 minutes" },
          expectedBusy: { type: "boolean", description: "Enable low-GPU-utilization warning when the cluster is expected to be serving work" },
          includeGrafanaAnnotations: { type: "boolean", description: "Read recent Grafana annotations to correlate deployment changes" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const lookbackMinutes = Math.max(5, Math.min(1_440, Math.round(optionalNumber(args, "lookbackMinutes") ?? 60)));
        const expectedBusy = optionalBoolean(args, "expectedBusy") ?? false;
        const includeGrafanaAnnotations = optionalBoolean(args, "includeGrafanaAnnotations") ?? true;

        if (!client.prometheusConfigured()) {
          return {
            generatedAt: new Date().toISOString(),
            severity: "unavailable" as const,
            summary: "Prometheus is not configured; no infrastructure action was executed.",
            connectorStatus: client.status(),
            checks: [],
            recommendedActions: ["Set CHERRY_PROMETHEUS_BASE_URL and verify access with observability_get_status."],
            executionPolicy: { autoExecuted: false, approvalRequiredForChanges: true },
          };
        }

        const definitions: CheckDefinition[] = [
          {
            id: "target_down",
            label: "Prometheus targets down",
            query: substituteLookback(healthConfig.targetDownQuery, lookbackMinutes),
            comparator: "gt",
            threshold: 0,
            aggregate: "max",
            triggeredSeverity: "critical",
            enabled: true,
            recommendedActions: [
              "Identify the down target labels, then inspect network reachability and the related service state.",
              "Use linux_service_status and linux_logs for the affected exporter or inference service.",
              "Only restart a service through linux_service_action after human approval, then verify the target is up.",
            ],
          },
          {
            id: "gpu_xid_errors",
            label: "GPU XID errors",
            query: substituteLookback(healthConfig.gpuXidQuery, lookbackMinutes),
            comparator: "gt",
            threshold: 0,
            aggregate: "sum",
            triggeredSeverity: "critical",
            enabled: true,
            recommendedActions: [
              "Inspect nvidia-smi -q and kernel logs for the affected GPU before restarting workloads.",
              "Drain or migrate workloads away from an unstable device if errors continue.",
              "Require approval for service restart, VM migration or host reboot and verify GPU health afterward.",
            ],
          },
          {
            id: "gpu_temperature",
            label: "Maximum GPU temperature",
            query: substituteLookback(healthConfig.gpuTempQuery, lookbackMinutes),
            comparator: "gt",
            threshold: healthConfig.highGpuTempThreshold,
            aggregate: "max",
            triggeredSeverity: "warning",
            enabled: true,
            recommendedActions: [
              "Inspect fan, airflow, power draw and workload placement for the hottest device.",
              "Reduce or migrate workload only after approval if temperature remains above threshold.",
            ],
          },
          {
            id: "inference_error_rate",
            label: "Inference HTTP 5xx error rate",
            query: substituteLookback(healthConfig.errorRateQuery, lookbackMinutes),
            comparator: "gt",
            threshold: healthConfig.highErrorRateThreshold,
            aggregate: "max",
            triggeredSeverity: "warning",
            enabled: true,
            recommendedActions: [
              "Correlate the spike with Grafana deployment annotations and recent service logs.",
              "Verify model endpoint health before proposing restart or rollback.",
              "Execute rollback or restart only through an approved dangerous/external tool and verify the error rate falls.",
            ],
          },
          {
            id: "workload_restarts",
            label: "Workload restarts",
            query: substituteLookback(healthConfig.restartQuery, lookbackMinutes),
            comparator: "gt",
            threshold: healthConfig.highRestartThreshold,
            aggregate: "sum",
            triggeredSeverity: "warning",
            enabled: true,
            recommendedActions: [
              "Inspect pod, container or systemd logs and determine whether OOM, health checks or deployment changes caused restarts.",
              "Do not increase replicas or restart again until the failure cause is identified.",
            ],
          },
          {
            id: "gpu_utilization",
            label: "Average GPU utilization",
            query: substituteLookback(healthConfig.gpuUtilQuery, lookbackMinutes),
            comparator: "lt",
            threshold: healthConfig.lowGpuUtilThreshold,
            aggregate: "max",
            triggeredSeverity: "warning",
            enabled: expectedBusy,
            recommendedActions: [
              "Check inference queue depth, model worker process state and endpoint health.",
              "Confirm the cluster is expected to be busy before treating low utilization as an incident.",
            ],
          },
        ];

        const checks = await Promise.all(definitions.map((definition) => executeCheck(client, definition)));
        const severity = checks.reduce<Severity>((current, check) => (
          severityRank(check.severity) > severityRank(current) ? check.severity : current
        ), "ok");

        const recommendedActions = [...new Set(
          checks.flatMap((check) => check.recommendedActions.map((action) => `[${check.label}] ${action}`)),
        )];

        let annotations: unknown = null;
        let annotationsError: string | null = null;
        if (includeGrafanaAnnotations && client.grafanaConfigured()) {
          try {
            annotations = await client.grafanaAnnotations({
              from: Date.now() - lookbackMinutes * 60_000,
              to: Date.now(),
              limit: 100,
            });
          } catch (error) {
            annotationsError = error instanceof Error ? error.message : String(error);
          }
        }

        const abnormalCount = checks.filter((check) => check.severity === "warning" || check.severity === "critical").length;
        const unavailableCount = checks.filter((check) => check.severity === "unavailable").length;

        return {
          generatedAt: new Date().toISOString(),
          lookbackMinutes,
          expectedBusy,
          severity,
          summary: abnormalCount
            ? `Detected ${abnormalCount} abnormal check(s); ${unavailableCount} check(s) unavailable. No action was executed.`
            : `No configured threshold breach detected; ${unavailableCount} check(s) unavailable. No action was executed.`,
          connectorStatus: client.status(),
          checks,
          grafanaAnnotations: annotations,
          grafanaAnnotationsError: annotationsError,
          recommendedActions,
          executionPolicy: {
            autoExecuted: false,
            approvalRequiredForChanges: true,
            nextStep: "Review evidence, select a narrow existing action tool, approve it, execute it, then verify with Prometheus and service health checks.",
          },
        };
      },
    },
  ];
}
