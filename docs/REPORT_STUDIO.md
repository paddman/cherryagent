# Cherry Report Studio

Report Studio turns one `.xlsx` or UTF-8 `.csv` table into a tenant-scoped dashboard and downloadable PDF. A built-in sales sample lets a new workspace reach a useful result without Gmail, Google Drive, or another connector.

## Execution and privacy

Every report creates an `AgenticRun` with six deterministic pipeline tasks:

```text
ingest → profile → analyze → visualize → pdf → verify
```

The server calculates column types, KPI, aggregates, trends, rankings, missing values, and anomaly warnings. The optional model receives only schema and aggregate evidence. Raw rows and category labels are not included in the model payload. If the model is unavailable, generation completes in `degraded` mode with deterministic insight and a valid PDF.

Source files and artifacts are stored under:

```text
workspace/<tenantId>/reports/<reportId>/
```

Metadata is stored in `.cherry/reports.json` for the pilot. Move metadata to PostgreSQL and artifacts to object storage before a multi-node production deployment.

## API

All routes use the existing bearer authentication and tenant boundary. `viewer` can list, read, stream, and download; `user` and `admin` can also upload, regenerate, and delete.

- `POST /reports` — multipart `file`, optional `template` and `title`; costs 20 credits.
- `POST /reports/sample` — starts the built-in sales report; costs 20 credits.
- `GET /reports` — lists reports for the current tenant.
- `GET /reports/:id` — returns current progress and completed report data.
- `GET /reports/:id/events` — live Server-Sent Events; the PWA falls back to polling every two seconds.
- `PATCH /reports/:id/mapping` — body `{ mapping: { dateColumn?, metrics, dimensions } }`; costs 10 credits.
- `GET /reports/:id/pdf` — downloads the generated PDF.
- `DELETE /reports/:id` — removes the tenant-scoped source and artifacts after generation stops.

Accepted templates are `auto`, `general`, `sales`, `finance`, and `operations`.

## Limits and file handling

Defaults:

```env
CHERRY_REPORT_FILE=.cherry/reports.json
CHERRY_REPORT_RETENTION_DAYS=30
CHERRY_REPORT_MAX_BYTES=20971520
CHERRY_REPORT_MAX_ROWS=100000
CHERRY_REPORT_MAX_COLUMNS=100
CHERRY_REPORT_MODEL_TIMEOUT_MS=25000
```

The largest populated worksheet is selected automatically. `.xls` and `.xlsm` are rejected. Workbook macros and formulas are never executed; formula cells use only cached results present in the workbook. MIME type, extension, ZIP signature, binary NUL content, row limit, and column limit are checked before report credits are consumed.

PDFs are rendered on the server with PDFKit, vector chart marks, and embedded Noto Sans Thai subsets. Each report exposes the source SHA-256, selected sheet, mapping, row/column counts, quality warnings, and evidence-linked insight.
