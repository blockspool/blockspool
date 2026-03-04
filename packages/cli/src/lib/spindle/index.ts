/**
 * Spindle Loop Detection
 *
 * Monitors agent execution for unproductive patterns:
 * - Oscillation: Similar diffs being applied and reverted
 * - Spinning: High tool call rate without progress
 * - Stalling: Verbose output without meaningful changes
 * - Repetition: Same errors or phrases repeated
 *
 * Named "Spindle" after the spinning wheel component — when the spindle
 * jams, it spins without producing thread.
 */

export type { SpindleConfig, SpindleState, SpindleResult } from './types.js';
export { DEFAULT_SPINDLE_CONFIG, createSpindleState, estimateTokens } from './types.js';
export { formatSpindleResult } from './format.js';

import type { SpindleConfig, SpindleState, SpindleResult } from './types.js';
import { estimateTokens } from './types.js';
import { metric } from '../metrics.js';
import {
  shortHash,
  detectQaPingPong,
  detectCommandFailure,
  extractFilesFromDiff,
  getFileEditWarnings as _getFileEditWarnings,
} from '@promptwheel/core/spindle/shared';

// ---------------------------------------------------------------------------
// similarity.ts (inlined)
// ---------------------------------------------------------------------------

/**
 * Compute similarity between two strings using Jaccard index on word tokens
 *
 * @returns Similarity score from 0 (completely different) to 1 (identical)
 */
export function computeSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;

  // Tokenize on whitespace and punctuation, lowercase
  const tokenize = (s: string): Set<string> => {
    const tokens = s
      .toLowerCase()
      .split(/[\s.,;:!?\-()[\]{}"']+/)
      .filter(t => t.length > 0);
    return new Set(tokens);
  };

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  // Jaccard index: |intersection| / |union|
  let intersectionSize = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersectionSize++;
    }
  }

  const unionSize = tokensA.size + tokensB.size - intersectionSize;
  return intersectionSize / unionSize;
}

/**
 * Find repeated phrases between two texts
 */
export function findRepeatedPhrases(a: string, b: string, maxResults: number = 5): string[] {
  const phrases: string[] = [];

  // Split into sentences/fragments
  const fragmentsA = a.split(/[.!?\n]+/).filter(f => f.trim().length > 20);
  const fragmentsB = b.split(/[.!?\n]+/).filter(f => f.trim().length > 20);

  for (const fragA of fragmentsA) {
    for (const fragB of fragmentsB) {
      const sim = computeSimilarity(fragA, fragB);
      if (sim >= 0.9) {
        phrases.push(fragA.trim().slice(0, 60) + '...');
        if (phrases.length >= maxResults) return phrases;
      }
    }
  }

  return phrases;
}

// ---------------------------------------------------------------------------
// oscillation.ts (inlined)
// ---------------------------------------------------------------------------

/**
 * Extract added and removed lines from a unified diff
 */
function extractDiffLines(diff: string): { added: string[]; removed: string[] } {
  const lines = diff.split('\n');
  const added: string[] = [];
  const removed: string[] = [];

  for (const line of lines) {
    // Skip diff headers
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      continue;
    }
    if (line.startsWith('+')) {
      added.push(line.slice(1).trim());
    } else if (line.startsWith('-')) {
      removed.push(line.slice(1).trim());
    }
  }

  return { added, removed };
}

/**
 * Detect oscillation pattern in diffs
 *
 * Looks for add→remove→add or remove→add→remove patterns where similar
 * content is being repeatedly changed back and forth.
 *
 * @returns Object with detected flag and pattern description
 */
export function detectOscillation(
  diffs: string[],
  similarityThreshold: number = 0.8
): { detected: boolean; pattern?: string; confidence: number } {
  if (diffs.length < 2) {
    return { detected: false, confidence: 0 };
  }

  // Analyze last 3 diffs (or 2 if only 2 available)
  const recentDiffs = diffs.slice(-3);
  const patterns = recentDiffs.map(d => extractDiffLines(d));

  // With 2 diffs: check if what was added is now removed (or vice versa)
  if (patterns.length >= 2) {
    const [prev, curr] = patterns.slice(-2);

    // Check: lines added in prev are now removed in curr
    for (const addedLine of prev.added) {
      if (addedLine.length < 3) continue; // Skip trivial lines
      for (const removedLine of curr.removed) {
        const sim = computeSimilarity(addedLine, removedLine);
        if (sim >= similarityThreshold) {
          return {
            detected: true,
            pattern: `Added then removed: "${addedLine.slice(0, 50)}..."`,
            confidence: sim,
          };
        }
      }
    }

    // Check: lines removed in prev are now added in curr
    for (const removedLine of prev.removed) {
      if (removedLine.length < 3) continue;
      for (const addedLine of curr.added) {
        const sim = computeSimilarity(removedLine, addedLine);
        if (sim >= similarityThreshold) {
          return {
            detected: true,
            pattern: `Removed then re-added: "${removedLine.slice(0, 50)}..."`,
            confidence: sim,
          };
        }
      }
    }
  }

  // With 3 diffs: check for A→B→A pattern
  if (patterns.length === 3) {
    const [first, , third] = patterns;

    // Check if first additions match third additions (came back to same state)
    for (const line1 of first.added) {
      if (line1.length < 3) continue;
      for (const line3 of third.added) {
        const sim = computeSimilarity(line1, line3);
        if (sim >= similarityThreshold) {
          return {
            detected: true,
            pattern: `Oscillating: same content added in iterations 1 and 3`,
            confidence: sim,
          };
        }
      }
    }
  }

  return { detected: false, confidence: 0 };
}

// ---------------------------------------------------------------------------
// repetition.ts (inlined)
// ---------------------------------------------------------------------------

/**
 * Detect repetition in agent outputs
 *
 * Looks for consecutive similar outputs that indicate the agent is stuck
 * in a loop saying the same things.
 */
export function detectRepetition(
  outputs: string[],
  latestOutput: string,
  config: SpindleConfig
): { detected: boolean; patterns: string[]; confidence: number } {
  const patterns: string[] = [];
  let maxSimilarity = 0;

  // Compare latest output with recent outputs
  for (const prevOutput of outputs.slice(-config.maxSimilarOutputs)) {
    const sim = computeSimilarity(latestOutput, prevOutput);
    if (sim >= config.similarityThreshold) {
      maxSimilarity = Math.max(maxSimilarity, sim);

      // Extract repeated phrases
      const phrases = findRepeatedPhrases(latestOutput, prevOutput);
      patterns.push(...phrases);
    }
  }

  // Check for common "stuck" phrases
  const stuckPhrases = [
    'let me try',
    'i apologize',
    "i'll try again",
    'let me attempt',
    'trying again',
    'one more time',
    'another approach',
  ];

  const lowerOutput = latestOutput.toLowerCase();
  for (const phrase of stuckPhrases) {
    if (lowerOutput.includes(phrase)) {
      const occurrences = outputs.filter(o =>
        o.toLowerCase().includes(phrase)
      ).length;
      if (occurrences >= 2) {
        patterns.push(`Repeated phrase: "${phrase}" (${occurrences + 1} times)`);
        // Set high similarity since stuck phrases are a strong signal
        maxSimilarity = Math.max(maxSimilarity, 0.85);
      }
    }
  }

  const detected = patterns.length > 0 && maxSimilarity >= config.similarityThreshold;
  return {
    detected,
    patterns: [...new Set(patterns)].slice(0, 5), // Dedupe and limit
    confidence: maxSimilarity,
  };
}

// ---------------------------------------------------------------------------
// failure-patterns.ts (inlined)
// ---------------------------------------------------------------------------

// Re-export shared detectors for consumers
export { shortHash, detectQaPingPong, detectCommandFailure, extractFilesFromDiff };

/** Get file edit frequency warnings from CLI SpindleState */
export function getFileEditWarnings(state: SpindleState, threshold: number = 3): string[] {
  return _getFileEditWarnings(state.fileEditCounts, threshold);
}

/** Record a failing command for spindle tracking */
export function recordCommandFailure(state: SpindleState, command: string, error: string): void {
  const sig = shortHash(`${command}::${error.slice(0, 200)}`);
  state.failingCommandSignatures.push(sig);
  if (state.failingCommandSignatures.length > 20) state.failingCommandSignatures.shift();
}

// ---------------------------------------------------------------------------
// checkSpindleLoop
// ---------------------------------------------------------------------------

/**
 * Check if agent is in a Spindle loop
 *
 * Updates state in-place and returns detection result.
 *
 * @param state - Current Spindle state (will be mutated)
 * @param latestOutput - Agent's latest output text
 * @param latestDiff - Latest git diff (null if no changes)
 * @param config - Spindle configuration
 * @returns Detection result
 */
export function checkSpindleLoop(
  state: SpindleState,
  latestOutput: string,
  latestDiff: string | null,
  config: SpindleConfig
): SpindleResult {
  // If disabled, always pass
  if (!config.enabled) {
    return { shouldAbort: false, shouldBlock: false, confidence: 0, diagnostics: {} };
  }

  // Update state with latest data
  const outputTokens = estimateTokens(latestOutput);
  const diffTokens = estimateTokens(latestDiff ?? '');

  state.estimatedTokens += outputTokens + diffTokens;
  state.totalOutputChars += latestOutput.length;
  state.totalChangeChars += (latestDiff ?? '').length;

  // Store for pattern detection (keep last N)
  state.outputs.push(latestOutput);
  if (state.outputs.length > config.maxSimilarOutputs + 1) {
    state.outputs.shift();
  }

  if (latestDiff) {
    state.diffs.push(latestDiff);
    if (state.diffs.length > 5) {
      state.diffs.shift();
    }

    // Track per-file edit frequency
    const editedFiles = extractFilesFromDiff(latestDiff);
    for (const f of editedFiles) {
      state.fileEditCounts[f] = (state.fileEditCounts[f] ?? 0) + 1;
    }
    // Cap file_edit_counts keys to prevent unbounded growth
    const MAX_FILE_EDIT_KEYS = 200;
    const editKeys = Object.keys(state.fileEditCounts);
    if (editKeys.length > MAX_FILE_EDIT_KEYS) {
      const sorted = Object.entries(state.fileEditCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_FILE_EDIT_KEYS);
      state.fileEditCounts = Object.fromEntries(sorted);
    }
  }

  // Track iterations without changes
  if (!latestDiff || latestDiff.trim() === '') {
    state.iterationsSinceChange++;
  } else {
    state.iterationsSinceChange = 0;
    state.lastProgressAt = Date.now();
  }

  // Check 1: Token budget
  if (state.estimatedTokens >= config.tokenBudgetAbort) {
    return triggerSpindle({
      shouldAbort: true,
      shouldBlock: false,
      reason: 'token_budget',
      confidence: 1.0,
      diagnostics: {
        estimatedTokens: state.estimatedTokens,
      },
    });
  }

  // Token budget warning (don't abort, just warn)
  if (state.estimatedTokens >= config.tokenBudgetWarning) {
    const warning = `Approaching token budget: ~${state.estimatedTokens} tokens`;
    if (!state.warnings.includes(warning)) {
      state.warnings.push(warning);
    }
  }

  // Check 2: Stalling (no changes for too many iterations)
  if (state.iterationsSinceChange >= config.maxStallIterations) {
    return triggerSpindle({
      shouldAbort: true,
      shouldBlock: false,
      reason: 'stalling',
      confidence: 0.9,
      diagnostics: {
        iterationsWithoutChange: state.iterationsSinceChange,
      },
    });
  }

  // Check 2b: Time-based stall (wall-clock)
  if (config.maxStallMinutes > 0) {
    const minutesSinceProgress = (Date.now() - state.lastProgressAt) / 60_000;
    if (minutesSinceProgress >= config.maxStallMinutes) {
      return triggerSpindle({
        shouldAbort: true,
        shouldBlock: false,
        reason: 'time_stall',
        confidence: 0.95,
        diagnostics: {
          minutesSinceProgress: Math.round(minutesSinceProgress),
          maxStallMinutes: config.maxStallMinutes,
        },
      });
    }
  }

  // Check 3: Oscillation in diffs
  if (state.diffs.length >= 2) {
    const oscillation = detectOscillation(state.diffs, config.similarityThreshold);
    if (oscillation.detected) {
      return triggerSpindle({
        shouldAbort: true,
        shouldBlock: false,
        reason: 'oscillation',
        confidence: oscillation.confidence,
        diagnostics: {
          oscillationPattern: oscillation.pattern,
        },
      });
    }
  }

  // Check 4: Repetition in outputs
  if (state.outputs.length >= 2) {
    const repetition = detectRepetition(state.outputs.slice(0, -1), latestOutput, config);
    if (repetition.detected) {
      return triggerSpindle({
        shouldAbort: true,
        shouldBlock: false,
        reason: 'repetition',
        confidence: repetition.confidence,
        diagnostics: {
          repeatedPatterns: repetition.patterns,
          similarityScore: repetition.confidence,
        },
      });
    }
  }

  // Check 5: Verbosity ratio (lots of output, few changes)
  if (state.totalOutputChars > 5000 && state.totalChangeChars > 0) {
    const verbosityRatio = state.totalOutputChars / state.totalChangeChars;
    if (verbosityRatio >= config.verbosityThreshold) {
      // Only warn, don't abort on verbosity alone
      const warning = `High verbosity ratio: ${verbosityRatio.toFixed(1)}x output vs changes`;
      if (!state.warnings.includes(warning)) {
        state.warnings.push(warning);
      }
    }
  }

  // Check 6: QA ping-pong — alternating failure signatures
  if (state.failingCommandSignatures.length >= config.maxQaPingPong * 2) {
    const pp = detectQaPingPong(state.failingCommandSignatures, config.maxQaPingPong);
    if (pp) {
      return triggerSpindle({
        shouldAbort: true,
        shouldBlock: false,
        reason: 'qa_ping_pong',
        confidence: 0.9,
        diagnostics: { pingPongPattern: pp },
      });
    }
  }

  // Check 7: Command signature — same command fails N times → block (needs human)
  const cmdFail = detectCommandFailure(state.failingCommandSignatures, config.maxCommandFailures);
  if (cmdFail) {
    return triggerSpindle({
      shouldAbort: false,
      shouldBlock: true,
      reason: 'command_failure',
      confidence: 0.8,
      diagnostics: { commandSignature: cmdFail, commandFailureThreshold: config.maxCommandFailures },
    });
  }

  // Check 8: File edit frequency warnings
  const fileWarnings = getFileEditWarnings(state, config.maxFileEdits);
  if (fileWarnings.length > 0) {
    for (const w of fileWarnings) {
      const warning = `File churn: ${w}`;
      if (!state.warnings.includes(warning)) {
        state.warnings.push(warning);
      }
    }
  }

  // No issues detected
  // Instrument: track spindle check (no trigger)
  metric('spindle', 'check_passed', {
    tokens: state.estimatedTokens,
    iterations: state.iterationsSinceChange,
  });

  return {
    shouldAbort: false,
    shouldBlock: false,
    confidence: 0,
    diagnostics: {
      estimatedTokens: state.estimatedTokens,
      iterationsWithoutChange: state.iterationsSinceChange,
      ...(fileWarnings.length > 0 ? { fileEditWarnings: fileWarnings } : {}),
    },
  };
}

/**
 * Helper to record spindle trigger and return result
 */
function triggerSpindle(result: SpindleResult): SpindleResult {
  metric('spindle', 'triggered', {
    reason: result.reason,
    shouldAbort: result.shouldAbort,
    shouldBlock: result.shouldBlock,
    confidence: result.confidence,
  });
  return result;
}
