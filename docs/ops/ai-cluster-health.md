# AI Cluster Health Workflow

CherryAgent now includes a read-only observability pack for Prometheus and Grafana plus a deterministic AI cluster health assessment.

## Operating policy

The health workflow never changes infrastructure by itself.

1. Read Prometheus metrics and active alerts.
2. Read Grafana annotations for deployment and maintenance context.
3. Produce findings, severity and recommended actions.
4. Let the operator review evidence.
5. Execute an existing infrastructure or Linux action only after Approval Gate authorization.
6. Verify the result with Prometheus, service state and endpoint checks.
7. Complete the Engineer Loop and save the verified incident as a reusable Runbook.

## Configuration

Copy `.env.example` to `.env` and configure at least Prometheus:

```env
CHERRY_PROMETHEUS_BASE_URL=http://prometheus.internal:9090
CHERRY_PROMETHEUS_BEARER_TOKEN=

CHERRY_GRAFANA_BASE_URL=http://grafana.internal:3000
CHERRY_GRAFANA_API_TOKEN=

CHERRY_OBSERVABILITY_VERIFY_TLS=true
CHERRY_OBSERVABILITY_TIMEOUT_MS=20000
```

The built-in PromQL defaults expect common NVIDIA DCGM exporter, Kubernetes and HTTP metrics. Override every expression that does not match your environment:

```env
CHERRY_OPS_GPU_UTIL_QUERY=avg(avg_over_time(DCGM_FI_DEV_GPU_UTIL[{{lookback}}]))
CHERRY_OPS_GPU_TEMP_QUERY=max(DCGM_FI_DEV_GPU_TEMP)
CHERRY_OPS_GPU_XID_QUERY=sum(increase(DCGM_FI_DEV_XID_ERRORS[{{lookback}}]))
CHERRY_OPS_ERROR_RATE_QUERY=sum(rate(http_requests_total{status=~"5.."}[5m])) / clamp_min(sum(rate(http_requests_total[5m])), 0.001)
CHERRY_OPS_TARGET_DOWN_QUERY=count(up == 0)
CHERRY_OPS_RESTART_QUERY=sum(increase(kube_pod_container_status_restarts_total[{{lookback}}]))
```

`{{lookback}}` is replaced at runtime, for example with `60m`.

Thresholds:

```env
CHERRY_OPS_GPU_UTIL_LOW=10
CHERRY_OPS_GPU_TEMP_HIGH=82
CHERRY_OPS_ERROR_RATE_HIGH=0.05
CHERRY_OPS_RESTART_HIGH=3
```

## Tools

| Tool | Risk | Purpose |
|---|---|---|
| `observability_get_status` | safe | Show Prometheus/Grafana configuration state |
| `prometheus_query` | safe | Run an instant PromQL query |
| `prometheus_query_range` | safe | Run a range query for trends and baselines |
| `prometheus_list_alerts` | safe | Read active alert states |
| `grafana_health` | safe | Verify Grafana API connectivity |
| `grafana_search` | safe | Find dashboards and folders |
| `grafana_annotations` | safe | Read deployment or maintenance annotations |
| `ops_ai_cluster_health_check` | safe | Run the combined read-only AI cluster assessment |

Existing action tools such as `linux_service_action`, `proxmox_migrate_vm`, `proxmox_reboot_vm`, `vsphere_power_off_vm` and raw `linux_exec` retain their existing external or dangerous risk levels and require approval under the recommended configuration.

## Example prompt

```text
เช็กความผิดปกติใน AI cluster ย้อนหลัง 60 นาที ช่วงนี้ควรมีงานรันอยู่
ใช้ Prometheus และ Grafana annotations สรุป severity, evidence, probable cause
และ action ที่แนะนำ ห้ามแก้ระบบจนกว่าผมจะ approve
```

The agent should call:

```text
observability_get_status
        ↓
ops_ai_cluster_health_check
        ↓
prometheus_list_alerts
        ↓
grafana_annotations
        ↓
Engineer Loop: observe → diagnose
        ↓
Action proposal only
        ↓
Operator approval
        ↓
Narrow action tool
        ↓
Prometheus/service/HTTP verification
        ↓
Engineer Loop: verify → learn → complete
```

## Direct tool arguments

```json
{
  "lookbackMinutes": 60,
  "expectedBusy": true,
  "includeGrafanaAnnotations": true
}
```

## Expected result shape

```json
{
  "severity": "warning",
  "summary": "Detected 1 abnormal check(s); 0 check(s) unavailable. No action was executed.",
  "checks": [
    {
      "id": "inference_error_rate",
      "severity": "warning",
      "observed": 0.08,
      "threshold": 0.05
    }
  ],
  "recommendedActions": [
    "Inspect service logs and correlate the spike with deployment annotations."
  ],
  "executionPolicy": {
    "autoExecuted": false,
    "approvalRequiredForChanges": true
  }
}
```

## Production notes

- Create read-only Prometheus and Grafana credentials.
- Keep `CHERRY_AUTO_APPROVE=safe,write`; do not add `external` or `dangerous` for unattended operation.
- Use trusted CA certificates when possible. Disable TLS verification only in an isolated test environment.
- Tune PromQL per exporter and metric labels before relying on severity thresholds.
- Verification must use independent evidence. A successful command exit code alone is not sufficient.
