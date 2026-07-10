import type { LlmProvider } from "../core/types.js";

export type CorrectnessVerdict = "pass" | "revise" | "needs_evidence";

export type CorrectnessReview = {
  verdict: CorrectnessVerdict;
  confidence: number;
  summary: string;
  issues: string[];
  missingEvidence: string[];
  suggestedAction: string;
};

export type CorrectnessStatus = {
  status: "verified" | "revised" | "unverified";
  confidence: number;
  passes: number;
  summary: string;
  issues: string[];
  missingEvidence: string[];
};

export type ReviewTraceEvent = {
  step: number;
  type: string;
  name?: string;
  detail: unknown;
};

const VERIFIER_PROMPT = `You are the independent correctness verifier for CherryAgent.

Your job is to check a candidate answer against the user's actual request and the observed tool evidence.

Rules:
1. Do not reveal chain-of-thought or hidden reasoning. Return only a concise verification result as JSON.
2. Do not assume an action succeeded unless tool evidence confirms it.
3. Detect contradictions, unsupported claims, missing verification, stale assumptions, partial completion, arithmetic mistakes, and mismatches with the user's request.
4. A successful external action must have tool-confirmed evidence. A technical fix must have test or verification evidence before being marked complete.
5. If the candidate is correct and sufficiently supported, verdict = "pass".
6. If the answer itself should be corrected without more tools, verdict = "revise".
7. If more real-world evidence or a tool call is required, verdict = "needs_evidence".
8. Confidence is an integer from 0 to 100.
9. Keep issues and missingEvidence concise and actionable.

Return exactly one JSON object with this shape:
{
  "verdict": "pass | revise | needs_evidence",
  "confidence": 0,
  "summary": "concise review summary",
  "issues": ["issue"],
  "missingEvidence": ["missing evidence"],
  "suggestedAction": "what Cherry should do next"
}`;

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function evidenceFromTrace(trace: ReviewTraceEvent[]): string {
  const relevant = trace
    .filter((event) => event.type === "tool" || event.type === "error")
    .slice(-40)
    .map((event) => {
      const label = event.name ? `${event.type}:${event.name}` : event.type;
      return `[step ${event.step} ${label}] ${clip(safeStringify(event.detail), 1_500)}`;
    });
  return clip(relevant.join("\n"), 16_000) || "No tool evidence was produced.";
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Correctness verifier did not return a JSON object");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Correctness verifier returned an invalid JSON object");
  }
  return parsed as Record<string, unknown>;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeReview(raw: Record<string, unknown>): CorrectnessReview {
  const verdict: CorrectnessVerdict = raw.verdict === "pass" || raw.verdict === "revise" || raw.verdict === "needs_evidence"
    ? raw.verdict
    : "revise";
  const numericConfidence = typeof raw.confidence === "number" ? raw.confidence : Number(raw.confidence);
  const confidence = Number.isFinite(numericConfidence)
    ? Math.min(100, Math.max(0, Math.round(numericConfidence)))
    : 0;

  return {
    verdict,
    confidence,
    summary: typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : "Verification review completed.",
    issues: stringList(raw.issues),
    missingEvidence: stringList(raw.missingEvidence),
    suggestedAction: typeof raw.suggestedAction === "string" && raw.suggestedAction.trim()
      ? raw.suggestedAction.trim()
      : verdict === "pass"
        ? "Return the candidate answer."
        : "Revise the answer and verify any unsupported claims.",
  };
}

export class CorrectnessLoop {
  constructor(
    private readonly provider: LlmProvider,
    readonly maxPasses: number,
  ) {}

  async review(input: {
    userMessage: string;
    candidateAnswer: string;
    trace: ReviewTraceEvent[];
    pass: number;
  }): Promise<CorrectnessReview> {
    const evidence = evidenceFromTrace(input.trace);
    const completion = await this.provider.complete({
      messages: [
        { role: "system", content: VERIFIER_PROMPT },
        {
          role: "user",
          content: `User request:\n${clip(input.userMessage, 8_000)}\n\nCandidate answer:\n${clip(input.candidateAnswer, 12_000)}\n\nObserved tool evidence:\n${evidence}\n\nCorrectness pass: ${input.pass}/${this.maxPasses}`,
        },
      ],
      tools: [],
    });

    const content = completion.message.content;
    if (!content) throw new Error("Correctness verifier returned empty content");
    return normalizeReview(extractJsonObject(content));
  }
}
