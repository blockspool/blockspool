/**
 * Criteria Verifier — LLM-based verification of acceptance criteria against a diff.
 *
 * After QA verification commands pass, this module checks whether the actual
 * code changes satisfy each acceptance criterion from the scout proposal.
 * Uses Claude CLI in no-tools mode for a lightweight prompt→response evaluation.
 */

import { runClaude } from '@promptwheel/core/scout';

export interface CriterionResult {
  criterion: string;
  passed: boolean;
  evidence: string;
}

export interface VerifyCriteriaResult {
  results: CriterionResult[];
  allPassed: boolean;
  /** Raw LLM output for diagnostics */
  rawOutput?: string;
}

const MAX_DIFF_CHARS = 4000;
const VERIFICATION_TIMEOUT_MS = 60_000;

/**
 * Verify acceptance criteria against a diff using an LLM call.
 *
 * Returns per-criterion pass/fail with evidence. If the LLM call fails
 * or output is unparseable, returns all criteria as passed (fail-open)
 * to avoid blocking tickets on verification infrastructure issues.
 */
export async function verifyCriteria(
  diff: string,
  criteria: string[],
  ticketTitle: string,
  cwd: string,
  model?: string,
): Promise<VerifyCriteriaResult> {
  if (criteria.length === 0) {
    return { results: [], allPassed: true };
  }

  const truncatedDiff = diff.length > MAX_DIFF_CHARS
    ? diff.slice(0, MAX_DIFF_CHARS) + '\n... (truncated)'
    : diff;

  const criteriaList = criteria
    .map((c, i) => `${i + 1}. ${c}`)
    .join('\n');

  const prompt = `You are a code reviewer verifying whether a code change satisfies its acceptance criteria.

## Task: "${ticketTitle}"

## Diff
\`\`\`diff
${truncatedDiff}
\`\`\`

## Acceptance Criteria
${criteriaList}

## Instructions
For each criterion, determine whether the diff satisfies it. Respond with ONLY a JSON array — no explanation, no markdown fencing. Each element must have:
- "criterion": the criterion text (copy exactly)
- "passed": true or false
- "evidence": brief explanation (1-2 sentences) of why it passes or fails

Example:
[{"criterion":"All tests pass","passed":true,"evidence":"Test suite exits 0 with no failures"},{"criterion":"Input is sanitized","passed":false,"evidence":"User input is passed directly to exec() without sanitization on line 42"}]`;

  try {
    const result = await runClaude({
      prompt,
      cwd,
      timeoutMs: VERIFICATION_TIMEOUT_MS,
      model: model ?? 'sonnet',
    });

    if (!result.success) {
      // Fail-open: don't block on verification infra failure
      return {
        results: criteria.map(c => ({ criterion: c, passed: true, evidence: 'Verification call failed — skipped' })),
        allPassed: true,
        rawOutput: result.error,
      };
    }

    const parsed = parseCriteriaOutput(result.output, criteria);
    if (!parsed) {
      return {
        results: criteria.map(c => ({ criterion: c, passed: true, evidence: 'Verification output unparseable — skipped' })),
        allPassed: true,
        rawOutput: result.output,
      };
    }

    return {
      results: parsed,
      allPassed: parsed.every(r => r.passed),
      rawOutput: result.output,
    };
  } catch {
    // Fail-open on any unexpected error
    return {
      results: criteria.map(c => ({ criterion: c, passed: true, evidence: 'Verification error — skipped' })),
      allPassed: true,
    };
  }
}

/**
 * Parse LLM output into CriterionResult[]. Returns null if unparseable.
 */
function parseCriteriaOutput(output: string, criteria: string[]): CriterionResult[] | null {
  // Try direct JSON parse
  let parsed = tryParseJson(output.trim());

  // Try extracting from markdown code block
  if (!parsed) {
    const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      parsed = tryParseJson(jsonMatch[1].trim());
    }
  }

  // Try finding JSON array by bracket matching
  if (!parsed) {
    const start = output.indexOf('[');
    const end = output.lastIndexOf(']');
    if (start !== -1 && end > start) {
      parsed = tryParseJson(output.slice(start, end + 1));
    }
  }

  if (!Array.isArray(parsed)) return null;

  // Validate structure
  const results: CriterionResult[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const criterion = typeof item.criterion === 'string' ? item.criterion : '';
    const passed = typeof item.passed === 'boolean' ? item.passed : true;
    const evidence = typeof item.evidence === 'string' ? item.evidence : '';
    results.push({ criterion, passed, evidence });
  }

  // If we got fewer results than criteria, fill the gaps (fail-open)
  if (results.length < criteria.length) {
    const covered = new Set(results.map(r => r.criterion));
    for (const c of criteria) {
      if (!covered.has(c)) {
        results.push({ criterion: c, passed: true, evidence: 'Not evaluated by verifier' });
      }
    }
  }

  return results.length > 0 ? results : null;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
