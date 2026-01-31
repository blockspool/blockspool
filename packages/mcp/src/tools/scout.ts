/**
 * Scout tools: scout_files, submit_proposals
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { repos, scout } from '@blockspool/core';
import type { SessionManager } from '../state.js';

export function registerScoutTools(server: McpServer, getState: () => SessionManager) {
  server.tool(
    'blockspool_scout_files',
    'Returns the scout prompt + file batch for Claude to analyze. BlockSpool selects which files to scan. You should process the prompt and return proposals via blockspool_submit_proposals.',
    {
      batchIndex: z.number().optional().describe('Which batch to process (0-indexed). Omit to get the next unprocessed batch.'),
    },
    async (params) => {
      const state = getState();
      const run = state.requireActive();

      const projectPath = state.project.rootPath;
      const scope = run.scope;

      // Scan files
      const files = scout.scanFiles({
        cwd: projectPath,
        include: [scope],
        exclude: [],
      });

      if (files.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              message: 'No files found matching scope.',
              scope,
              projectPath,
            }),
          }],
        };
      }

      // Batch them
      const batches = scout.batchFiles(files, 3);
      const batchIndex = params.batchIndex ?? run.scout_cycles;

      if (batchIndex >= batches.length) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              message: 'All file batches have been processed.',
              totalBatches: batches.length,
              processed: run.scout_cycles,
            }),
          }],
        };
      }

      const batch = batches[batchIndex];

      // Get dedup context
      const recentTickets = await repos.tickets.getRecentlyCompleted(state.db, run.project_id, 20);
      const recentTitles = recentTickets.map(t => t.title);

      // Build the scout prompt
      const prompt = scout.buildScoutPrompt({
        files: batch.map(f => ({ path: f.path, content: f.content })),
        scope,
        types: run.categories as any,
        maxProposals: run.max_proposals_per_scout,
        minConfidence: run.min_confidence,
        recentlyCompletedTitles: recentTitles,
        customPrompt: run.formula ? `Formula: ${run.formula}` : undefined,
      });

      // Track scout cycle
      const s = state.run.require();
      s.scout_cycles++;
      state.run.appendEvent('ADVANCE_CALLED', { phase: 'SCOUT', batch_index: batchIndex });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            batchIndex,
            totalBatches: batches.length,
            filesInBatch: batch.map(f => f.path),
            prompt,
            instructions: 'Analyze the code according to the prompt above. Return proposals via blockspool_submit_proposals.',
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'blockspool_submit_proposals',
    'Submit discovered proposals from scouting. BlockSpool filters via trust ladder, dedup, and confidence threshold. Returns accepted tickets.',
    {
      proposals: z.array(z.object({
        category: z.enum(['refactor', 'docs', 'test', 'perf', 'security']),
        title: z.string(),
        description: z.string(),
        acceptance_criteria: z.array(z.string()),
        verification_commands: z.array(z.string()),
        allowed_paths: z.array(z.string()),
        files: z.array(z.string()),
        confidence: z.number(),
        impact_score: z.number().optional(),
        rationale: z.string(),
        estimated_complexity: z.enum(['trivial', 'simple', 'moderate', 'complex']),
      })).describe('Array of proposals from scout analysis.'),
    },
    async (params) => {
      const state = getState();
      const run = state.requireActive();
      const minConfidence = run.min_confidence;

      // Trust ladder
      const allowedCategories = new Set(run.categories);

      // Cap proposals
      const capped = params.proposals.slice(0, run.max_proposals_per_scout);

      // Filter proposals
      const accepted = capped.filter(p => {
        if (p.confidence < minConfidence) return false;
        if (!allowedCategories.has(p.category)) return false;
        return true;
      });

      state.run.appendEvent('SCOUT_OUTPUT', {
        submitted: params.proposals.length,
        capped_to: capped.length,
      });

      if (accepted.length === 0) {
        state.run.appendEvent('PROPOSALS_FILTERED', { accepted: 0 });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              message: 'No proposals passed filtering.',
              submitted: params.proposals.length,
              accepted: 0,
              reasons: 'Filtered by confidence threshold or category trust ladder.',
            }),
          }],
        };
      }

      // Dedup against existing tickets
      const existingTickets = await repos.tickets.listByProject(state.db, run.project_id);
      const existingTitles = new Set(existingTickets.map(t => t.title.toLowerCase()));
      const deduped = accepted.filter(p => !existingTitles.has(p.title.toLowerCase()));

      state.run.appendEvent('PROPOSALS_FILTERED', {
        accepted: accepted.length,
        deduped: deduped.length,
        duplicates: accepted.length - deduped.length,
      });

      if (deduped.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              message: 'All proposals were duplicates of existing tickets.',
              submitted: params.proposals.length,
              accepted: 0,
            }),
          }],
        };
      }

      // Create tickets
      const ticketInputs = deduped.map(p => ({
        projectId: run.project_id,
        title: p.title,
        description: formatDescription(p),
        status: 'ready' as const,
        priority: p.confidence,
        category: p.category,
        allowedPaths: p.allowed_paths,
        verificationCommands: p.verification_commands,
      }));

      const created = await repos.tickets.createMany(state.db, ticketInputs);

      state.run.appendEvent('TICKETS_CREATED', {
        count: created.length,
        ids: created.map(t => t.id),
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            submitted: params.proposals.length,
            accepted: created.length,
            filtered: params.proposals.length - deduped.length,
            tickets: created.map(t => ({
              id: t.id,
              title: t.title,
              category: t.category,
              priority: t.priority,
            })),
            message: `Created ${created.length} tickets. Use blockspool_next_ticket to start execution.`,
          }, null, 2),
        }],
      };
    },
  );
}

function formatDescription(proposal: {
  description: string;
  acceptance_criteria: string[];
  rationale: string;
  files: string[];
  estimated_complexity: string;
  confidence: number;
}): string {
  return [
    proposal.description,
    '',
    '## Acceptance Criteria',
    ...proposal.acceptance_criteria.map(c => `- ${c}`),
    '',
    '## Rationale',
    proposal.rationale,
    '',
    '## Files',
    ...proposal.files.map(f => `- \`${f}\``),
    '',
    `**Complexity:** ${proposal.estimated_complexity}`,
    `**Confidence:** ${proposal.confidence}%`,
  ].join('\n');
}
