import { ObservabilityClient } from "./connectors/observability/ObservabilityClient.js";
import type { AgentTool } from "./core/types.js";
import { createObservabilityTools, type AiClusterHealthConfig } from "./tools/builtin/observability.js";

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function integerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function healthConfig(): AiClusterHealthConfig {
  return {
    gpuUtilQuery: optionalEnv("CHERRY_OPS_GPU_UTIL_QUERY")
      ?? "avg(avg_over_time(DCGM_FI_DEV_GPU_UTIL[{{lookback}}]))",
    gpuTempQuery: optionalEnv("CHERRY_OPS_GPU_TEMP_QUERY")
      ?? "max(DCGM_FI_DEV_GPU_TEMP)",
    gpuXidQuery: optionalEnv("CHERRY_OPS_GPU_XID_QUERY")
      ?? "sum(increase(DCGM_FI_DEV_XID_ERRORS[{{lookback}}]))",
    errorRateQuery: optionalEnv("CHERRY_OPS_ERROR_RATE_QUERY")
      ?? "sum(rate(http_requests_total{status=~\"5..\"}[5m])) / clamp_min(sum(rate(http_requests_total[5m])), 0.001)",
    targetDownQuery: optionalEnv("CHERRY_OPS_TARGET_DOWN_QUERY")
      ?? "count(up == 0)",
    restartQuery: optionalEnv("CHERRY_OPS_RESTART_QUERY")
      ?? "sum(increase(kube_pod_container_status_restarts_total[{{lookback}}]))",
    lowGpuUtilThreshold: numberEnv("CHERRY_OPS_GPU_UTIL_LOW", 10),
    highGpuTempThreshold: numberEnv("CHERRY_OPS_GPU_TEMP_HIGH", 82),
    highErrorRateThreshold: numberEnv("CHERRY_OPS_ERROR_RATE_HIGH", 0.05),
    highRestartThreshold: numberEnv("CHERRY_OPS_RESTART_HIGH", 3),
  };
}

export function createObservabilityRuntimeClient(): ObservabilityClient {
  const prometheusBaseUrl = optionalEnv("CHERRY_PROMETHEUS_BASE_URL");
  const prometheusBearerToken = optionalEnv("CHERRY_PROMETHEUS_BEARER_TOKEN");
  const grafanaBaseUrl = optionalEnv("CHERRY_GRAFANA_BASE_URL");
  const grafanaApiToken = optionalEnv("CHERRY_GRAFANA_API_TOKEN");

  return new ObservabilityClient({
    ...(prometheusBaseUrl ? { prometheusBaseUrl } : {}),
    ...(prometheusBearerToken ? { prometheusBearerToken } : {}),
    ...(grafanaBaseUrl ? { grafanaBaseUrl } : {}),
    ...(grafanaApiToken ? { grafanaApiToken } : {}),
    rejectUnauthorized: booleanEnv("CHERRY_OBSERVABILITY_VERIFY_TLS", true),
    timeoutMs: integerEnv("CHERRY_OBSERVABILITY_TIMEOUT_MS", 20_000),
  });
}

export function getObservabilityRuntimeStatus(): ReturnType<ObservabilityClient["status"]> {
  return createObservabilityRuntimeClient().status();
}

export function createObservabilityRuntimeTools(): AgentTool[] {
  return createObservabilityTools(createObservabilityRuntimeClient(), healthConfig());
}
