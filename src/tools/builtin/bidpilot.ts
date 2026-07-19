import type { BidPilotEngine } from "../../connectors/documents/BidPilotEngine.js";
import type { AgentTool } from "../../core/types.js";

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${key} must be an array of non-empty strings`);
  }
  return value.map((item) => String(item).trim());
}

export function createBidPilotTools(engine: BidPilotEngine): AgentTool[] {
  return [
    {
      name: "bidpilot_extract_document",
      description: "Extract text from a TOR/RFP or evidence document in the CherryAgent workspace. Supports text-like files and PDF through pdftotext, with optional Thai/English OCR fallback. Writes a verified UTF-8 text artifact.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Source path relative to the CherryAgent workspace" },
          outputPath: { type: "string", description: "Optional extracted .txt output path inside the workspace" },
          ocr: { type: "boolean", description: "Use OCR fallback for scanned PDFs; defaults to true when embedded text is insufficient" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const outputPath = optionalString(args, "outputPath");
        const ocr = optionalBoolean(args, "ocr");
        return engine.extractDocument({
          workspaceRoot: context.workspaceRoot,
          path: requiredString(args, "path"),
          ...(outputPath ? { outputPath } : {}),
          ...(ocr === undefined ? {} : { ocr }),
        });
      },
    },
    {
      name: "bidpilot_extract_requirements",
      description: "Turn previously extracted TOR/RFP text into a structured JSON requirement list with source pages, category, mandatory flag, and expected evidence. This is deterministic pre-screening and should be reviewed by a human or a specialist agent.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          textPath: { type: "string", description: "Extracted UTF-8 text path" },
          outputPath: { type: "string", description: "Optional requirement JSON output path" },
          projectName: { type: "string" },
        },
        required: ["textPath"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const outputPath = optionalString(args, "outputPath");
        const projectName = optionalString(args, "projectName");
        return engine.extractRequirements({
          workspaceRoot: context.workspaceRoot,
          textPath: requiredString(args, "textPath"),
          ...(outputPath ? { outputPath } : {}),
          ...(projectName ? { projectName } : {}),
        });
      },
    },
    {
      name: "bidpilot_create_compliance_matrix",
      description: "Create JSON, CSV, and Markdown compliance matrices by matching structured requirements against extracted company evidence. Results are evidence_found/partial/missing/manual_review and never constitute final compliance approval.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          requirementsPath: { type: "string" },
          evidencePaths: { type: "array", items: { type: "string" } },
          outputBasePath: { type: "string", description: "Output base without extension" },
          projectName: { type: "string" },
          organizationName: { type: "string" },
        },
        required: ["requirementsPath"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const evidencePaths = optionalStringArray(args, "evidencePaths");
        const outputBasePath = optionalString(args, "outputBasePath");
        const projectName = optionalString(args, "projectName");
        const organizationName = optionalString(args, "organizationName");
        return engine.createComplianceMatrix({
          workspaceRoot: context.workspaceRoot,
          requirementsPath: requiredString(args, "requirementsPath"),
          ...(evidencePaths ? { evidencePaths } : {}),
          ...(outputBasePath ? { outputBasePath } : {}),
          ...(projectName ? { projectName } : {}),
          ...(organizationName ? { organizationName } : {}),
        });
      },
    },
    {
      name: "bidpilot_generate_proposal",
      description: "Generate a reviewable Markdown technical proposal scaffold from a BidPilot compliance matrix. It includes requirement responses, missing-evidence questions, risk sections, and an approval checklist.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          matrixPath: { type: "string" },
          outputPath: { type: "string" },
          projectName: { type: "string" },
          customerName: { type: "string" },
          bidderName: { type: "string" },
        },
        required: ["matrixPath"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const outputPath = optionalString(args, "outputPath");
        const projectName = optionalString(args, "projectName");
        const customerName = optionalString(args, "customerName");
        const bidderName = optionalString(args, "bidderName");
        return engine.generateProposal({
          workspaceRoot: context.workspaceRoot,
          matrixPath: requiredString(args, "matrixPath"),
          ...(outputPath ? { outputPath } : {}),
          ...(projectName ? { projectName } : {}),
          ...(customerName ? { customerName } : {}),
          ...(bidderName ? { bidderName } : {}),
        });
      },
    },
    {
      name: "bidpilot_run_pipeline",
      description: "Run the BidPilot MVP end to end: extract TOR/RFP text, identify requirements, extract optional evidence documents, create compliance matrix artifacts, create a proposal draft, and write a verified manifest.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          sourcePath: { type: "string", description: "TOR/RFP path inside the workspace" },
          evidencePaths: { type: "array", items: { type: "string" } },
          outputDir: { type: "string" },
          projectName: { type: "string" },
          organizationName: { type: "string" },
          customerName: { type: "string" },
          ocr: { type: "boolean" },
        },
        required: ["sourcePath"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const evidencePaths = optionalStringArray(args, "evidencePaths");
        const outputDir = optionalString(args, "outputDir");
        const projectName = optionalString(args, "projectName");
        const organizationName = optionalString(args, "organizationName");
        const customerName = optionalString(args, "customerName");
        const ocr = optionalBoolean(args, "ocr");
        return engine.runPipeline({
          workspaceRoot: context.workspaceRoot,
          sourcePath: requiredString(args, "sourcePath"),
          ...(evidencePaths ? { evidencePaths } : {}),
          ...(outputDir ? { outputDir } : {}),
          ...(projectName ? { projectName } : {}),
          ...(organizationName ? { organizationName } : {}),
          ...(customerName ? { customerName } : {}),
          ...(ocr === undefined ? {} : { ocr }),
        });
      },
    },
  ];
}
