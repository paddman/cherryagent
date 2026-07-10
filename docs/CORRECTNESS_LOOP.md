# Correctness Loop

CherryAgent runs an independent bounded correctness review before accepting a final answer.

```text
Candidate answer
      |
      v
Correctness verifier
      |
      +--> pass ----------> final answer
      |
      +--> revise --------> revise candidate --> verify again
      |
      +--> needs_evidence -> call tools -------> verify again
```

The verifier checks the candidate against:

- the user's actual request
- successful and failed tool results
- observable verification evidence
- unsupported success claims
- contradictions
- incomplete work
- missing evidence
- arithmetic or factual inconsistencies visible in the trace

The verifier does not expose chain-of-thought. It emits a concise structured review:

```json
{
  "verdict": "pass | revise | needs_evidence",
  "confidence": 0,
  "summary": "concise review summary",
  "issues": [],
  "missingEvidence": [],
  "suggestedAction": "next action"
}
```

Configuration:

```env
CHERRY_CORRECTNESS_MAX_PASSES=3
```

Allowed range: 1-5.

If the verifier cannot reach `pass` within the configured budget, the result is returned with `correctness.status = "unverified"` instead of falsely claiming full verification.

Agent API results include:

```json
{
  "answer": "...",
  "steps": 7,
  "correctness": {
    "status": "verified | revised | unverified",
    "confidence": 96,
    "passes": 2,
    "summary": "...",
    "issues": [],
    "missingEvidence": []
  }
}
```
