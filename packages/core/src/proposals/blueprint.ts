/**
 * Proposal Blueprint — pure-function pre-analysis of scout proposals.
 *
 * Groups proposals by file overlap, detects conflicts, identifies enablers
 * (proposals that unblock others via dependency edges), and finds mergeable
 * near-duplicates. Output feeds into trajectory generation prompts.
 *
 * No I/O, no LLM calls. All functions are deterministic.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProposalInput {
  title: string;
  category: string;
  files: string[];
  impact_score?: number;
  confidence: number;
}

export interface ProposalGroup {
  theme: string;
  proposalIndices: number[];
  commonScope: string;
  suggestedOrder: number;
  isEnabler: boolean;
}

export interface ProposalConflict {
  indexA: number;
  indexB: number;
  reason: string;
  resolution: 'keep_higher_impact' | 'merge' | 'sequence';
}

export interface ProposalBlueprint {
  groups: ProposalGroup[];
  conflicts: ProposalConflict[];
  enablers: number[];
  mergeablePairs: [number, number][];
  executionArc: string;
}

// ---------------------------------------------------------------------------
// Core algorithms
// ---------------------------------------------------------------------------

/**
 * Compute Jaccard overlap between two file sets.
 */
function fileOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const f of setA) {
    if (setB.has(f)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Find the common parent directory of a set of files.
 * Returns the shared prefix path or '' if none.
 */
function commonParentDir(files: string[]): string {
  if (files.length === 0) return '';
  const dirs = files
    .map(f => f.split('/').slice(0, -1))
    .filter(d => d.length > 0);
  if (dirs.length === 0) return '';
  const first = dirs[0];
  let commonLen = first.length;
  for (const dir of dirs.slice(1)) {
    let i = 0;
    while (i < commonLen && i < dir.length && first[i] === dir[i]) i++;
    commonLen = i;
  }
  if (commonLen === 0) return '';
  return first.slice(0, commonLen).join('/');
}

/**
 * Group proposals by file overlap (>=50% Jaccard similarity).
 * Uses single-linkage: if proposal C overlaps with A (already grouped),
 * C joins A's group.
 */
export function groupByFileOverlap(proposals: ProposalInput[], overlapThreshold = 0.5): ProposalGroup[] {
  const n = proposals.length;
  const groupId = new Array<number>(n);
  for (let i = 0; i < n; i++) groupId[i] = i;

  // Union-find helpers
  function find(i: number): number {
    while (groupId[i] !== i) {
      groupId[i] = groupId[groupId[i]];
      i = groupId[i];
    }
    return i;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) groupId[rb] = ra;
  }

  // Merge proposals with file overlap >= threshold
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (fileOverlap(proposals[i].files, proposals[j].files) >= overlapThreshold) {
        union(i, j);
      }
    }
  }

  // Collect groups
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let arr = groups.get(root);
    if (!arr) {
      arr = [];
      groups.set(root, arr);
    }
    arr.push(i);
  }

  // Build ProposalGroup objects
  const result: ProposalGroup[] = [];
  let order = 1;
  for (const indices of groups.values()) {
    const allFiles = [...new Set(indices.flatMap(i => proposals[i].files))];
    const parentDir = commonParentDir(allFiles);
    const scope = parentDir ? `${parentDir}/**` : allFiles.length > 0 ? allFiles[0].split('/').slice(0, -1).join('/') + '/**' : '**';

    // Theme from categories present
    const cats = [...new Set(indices.map(i => proposals[i].category))];
    const theme = cats.join('+');

    result.push({
      theme,
      proposalIndices: indices,
      commonScope: scope,
      suggestedOrder: order++,
      isEnabler: false, // set later by identifyEnablers
    });
  }

  return result;
}

/**
 * Detect conflicts: proposals touching the same file but with different categories.
 * Higher-impact proposal wins by default.
 */
export function detectConflicts(proposals: ProposalInput[]): ProposalConflict[] {
  const conflicts: ProposalConflict[] = [];
  const n = proposals.length;

  for (let i = 0; i < n; i++) {
    const filesA = new Set(proposals[i].files);
    for (let j = i + 1; j < n; j++) {
      if (proposals[i].category === proposals[j].category) continue;

      // Check for shared files
      const shared: string[] = [];
      for (const f of proposals[j].files) {
        if (filesA.has(f)) shared.push(f);
      }
      if (shared.length === 0) continue;

      const scoreA = (proposals[i].impact_score ?? 5) * (proposals[i].confidence / 100);
      const scoreB = (proposals[j].impact_score ?? 5) * (proposals[j].confidence / 100);
      const scoreDiff = Math.abs(scoreA - scoreB);

      conflicts.push({
        indexA: i,
        indexB: j,
        reason: `Both touch ${shared.join(', ')} but categories differ (${proposals[i].category} vs ${proposals[j].category})`,
        resolution: scoreDiff > 1 ? 'keep_higher_impact' : 'sequence',
      });
    }
  }

  return conflicts;
}

/**
 * Identify enabler proposals — proposals whose files are depended upon by
 * other proposals' files (based on dependency edges).
 */
export function identifyEnablers(
  proposals: ProposalInput[],
  depEdges: Record<string, string[]>,
): number[] {
  if (Object.keys(depEdges).length === 0) return [];

  // Build a set of modules touched by each proposal (parent dir of each file)
  const proposalModules: Set<string>[] = proposals.map(p => {
    const mods = new Set<string>();
    for (const f of p.files) {
      const dir = f.split('/').slice(0, -1).join('/');
      if (dir) mods.add(dir);
    }
    return mods;
  });

  // Build reverse edge map: module → modules that depend on it
  const reverseEdges = new Map<string, Set<string>>();
  for (const [mod, deps] of Object.entries(depEdges)) {
    for (const dep of deps) {
      let rev = reverseEdges.get(dep);
      if (!rev) {
        rev = new Set();
        reverseEdges.set(dep, rev);
      }
      rev.add(mod);
    }
  }

  const enablers: number[] = [];
  for (let i = 0; i < proposals.length; i++) {
    // Check if any module touched by proposal i is imported by modules from other proposals
    for (const mod of proposalModules[i]) {
      const dependents = reverseEdges.get(mod);
      if (!dependents) continue;
      for (let j = 0; j < proposals.length; j++) {
        if (j === i) continue;
        for (const otherMod of proposalModules[j]) {
          if (dependents.has(otherMod)) {
            enablers.push(i);
            // Break out of all inner loops
            break;
          }
        }
        if (enablers[enablers.length - 1] === i) break;
      }
      if (enablers[enablers.length - 1] === i) break;
    }
  }

  return [...new Set(enablers)];
}

/**
 * Detect mergeable pairs: >=70% file overlap + same category = likely duplicate.
 */
export function detectMergeablePairs(proposals: ProposalInput[], overlapThreshold = 0.7): [number, number][] {
  const pairs: [number, number][] = [];
  const n = proposals.length;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (proposals[i].category !== proposals[j].category) continue;
      if (fileOverlap(proposals[i].files, proposals[j].files) >= overlapThreshold) {
        pairs.push([i, j]);
      }
    }
  }

  return pairs;
}

/**
 * Compute a full blueprint from proposals and optional dependency edges.
 */
export function computeBlueprint(
  proposals: ProposalInput[],
  depEdges: Record<string, string[]> = {},
  config?: { groupOverlapThreshold?: number; mergeableOverlapThreshold?: number },
): ProposalBlueprint {
  const groups = groupByFileOverlap(proposals, config?.groupOverlapThreshold);
  const conflicts = detectConflicts(proposals);
  const enablers = identifyEnablers(proposals, depEdges);
  const mergeablePairs = detectMergeablePairs(proposals, config?.mergeableOverlapThreshold);

  // Mark enabler groups and adjust ordering (enablers first)
  const enablerSet = new Set(enablers);
  for (const group of groups) {
    group.isEnabler = group.proposalIndices.some(i => enablerSet.has(i));
  }
  // Re-sort: enablers first, then by original order
  groups.sort((a, b) => {
    if (a.isEnabler && !b.isEnabler) return -1;
    if (!a.isEnabler && b.isEnabler) return 1;
    return a.suggestedOrder - b.suggestedOrder;
  });
  // Re-number suggested orders
  for (let i = 0; i < groups.length; i++) {
    groups[i].suggestedOrder = i + 1;
  }

  // Build execution arc summary
  const arcParts: string[] = [];
  if (enablers.length > 0) {
    arcParts.push(`${enablers.length} enabler(s) should go first`);
  }
  if (conflicts.length > 0) {
    arcParts.push(`${conflicts.length} conflict(s) need isolation`);
  }
  if (mergeablePairs.length > 0) {
    arcParts.push(`${mergeablePairs.length} pair(s) can be merged`);
  }
  arcParts.push(`${groups.length} group(s) total`);
  const executionArc = arcParts.join(', ');

  return { groups, conflicts, enablers, mergeablePairs, executionArc };
}

/**
 * Format a blueprint as compact text for injection into the LLM prompt.
 */
export function formatBlueprintForPrompt(
  blueprint: ProposalBlueprint,
  proposals: ProposalInput[],
): string {
  const lines: string[] = [];

  lines.push(`Arc: ${blueprint.executionArc}`);
  lines.push('');

  // Groups
  lines.push('Groups:');
  for (const g of blueprint.groups) {
    const titles = g.proposalIndices.map(i => proposals[i].title).join(', ');
    lines.push(`  ${g.suggestedOrder}. [${g.theme}] ${titles} → scope: ${g.commonScope}${g.isEnabler ? ' (ENABLER)' : ''}`);
  }

  // Conflicts
  if (blueprint.conflicts.length > 0) {
    lines.push('');
    lines.push('Conflicts:');
    for (const c of blueprint.conflicts) {
      lines.push(`  - #${c.indexA + 1} vs #${c.indexB + 1}: ${c.reason} → ${c.resolution}`);
    }
  }

  // Mergeable
  if (blueprint.mergeablePairs.length > 0) {
    lines.push('');
    lines.push('Mergeable (>=70% overlap, same category):');
    for (const [a, b] of blueprint.mergeablePairs) {
      lines.push(`  - #${a + 1} "${proposals[a].title}" + #${b + 1} "${proposals[b].title}"`);
    }
  }

  return lines.join('\n');
}
