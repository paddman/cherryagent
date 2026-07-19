# CherryAgent BidPilot MVP

BidPilot is the first vertical workflow pack for CherryAgent. It turns a TOR/RFP and supporting company evidence into reviewable bid artifacts while keeping all files inside the configured CherryAgent workspace.

## What is implemented

The runtime now registers five tools:

- `bidpilot_extract_document`
- `bidpilot_extract_requirements`
- `bidpilot_create_compliance_matrix`
- `bidpilot_generate_proposal`
- `bidpilot_run_pipeline`

The end-to-end pipeline performs:

```text
TOR / RFP
   ↓
PDF text extraction or Thai/English OCR
   ↓
Structured requirement JSON with page references
   ↓
Evidence matching against company documents
   ↓
Compliance matrix: JSON + CSV + Markdown
   ↓
Reviewable proposal draft + approval checklist
   ↓
Verified run manifest
```

## Safety and accuracy contract

BidPilot deliberately does **not** mark a requirement as legally or technically compliant. Automated statuses are limited to:

- `evidence_found`
- `partial`
- `missing`
- `manual_review`

Every generated matrix and proposal contains a warning that a responsible person must validate the result before submission. Generated files are written only inside `CHERRY_WORKSPACE`, and the engine rejects path traversal outside that sandbox.

## System requirements for PDF and OCR

Text PDFs use Poppler's `pdftotext` command. Scanned PDFs use `pdftoppm` followed by Tesseract OCR with Thai and English language data.

The command names can be changed in `.env`:

```env
CHERRY_BIDPILOT_PDFTOTEXT_BIN=pdftotext
CHERRY_BIDPILOT_PDFTOPPM_BIN=pdftoppm
CHERRY_BIDPILOT_TESSERACT_BIN=tesseract
CHERRY_BIDPILOT_OCR_LANGUAGES=tha+eng
CHERRY_BIDPILOT_MAX_OCR_PAGES=30
CHERRY_BIDPILOT_TIMEOUT_MS=120000
CHERRY_BIDPILOT_MAX_DOCUMENT_BYTES=25000000
```

TXT, Markdown, CSV, JSON, XML, and HTML files work without external document binaries.

## Workspace example

Place the source and evidence files inside the workspace:

```text
workspace/
  bids/
    nt-ai-tor.pdf
    evidence/
      company-profile.pdf
      iso-27001.txt
      reference-projects.md
```

Then ask CherryAgent:

```text
Run BidPilot for bids/nt-ai-tor.pdf.
Use the evidence files under bids/evidence.
Project name: NT Private AI Platform.
Bidder: CherryAgent.
Customer: NT.
Create a compliance matrix and proposal draft, but do not claim final compliance.
```

Equivalent tool arguments:

```json
{
  "sourcePath": "bids/nt-ai-tor.pdf",
  "evidencePaths": [
    "bids/evidence/company-profile.pdf",
    "bids/evidence/iso-27001.txt",
    "bids/evidence/reference-projects.md"
  ],
  "projectName": "NT Private AI Platform",
  "organizationName": "CherryAgent",
  "customerName": "NT",
  "ocr": true
}
```

## Generated artifacts

A run is saved under:

```text
workspace/.bidpilot/runs/<timestamp>-<project>/
```

Files include:

- `source.txt`
- `requirements.json`
- `compliance-matrix.json`
- `compliance-matrix.csv`
- `compliance-matrix.md`
- `proposal-draft.md`
- `manifest.json`
- extracted evidence text when the evidence source is a PDF

The manifest records each artifact path and whether the final write was verified.

## Current MVP limits

- Requirement extraction is deterministic rule-based pre-screening; CherryAgent or a specialist sub-agent should review classification and merge/split requirements.
- Evidence matching is lexical and conservative. It surfaces likely supporting text but does not understand every technical equivalence.
- Output is Markdown/CSV/JSON. DOCX and XLSX styled exports remain a later document-generation layer.
- OCR is capped by `CHERRY_BIDPILOT_MAX_OCR_PAGES` to control runtime and resource use.
