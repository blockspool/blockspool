/**
 * Trajectory management tools: list, show, activate, pause, resume, skip, reset
 *
 * Enables trajectory workflows from the Claude Code plugin, providing
 * parity with the CLI's `trajectory` subcommands.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SessionManager } from '../state.js';
import {
  loadTrajectories,
  loadTrajectory,
  loadTrajectoryState,
  saveTrajectoryState,
  clearTrajectoryState,
  activateTrajectory,
} from '../trajectory-io.js';
import {
  getNextStep,
  skipStep,
  trajectoryStuck,
  trajectoryComplete,
} from '@promptwheel/core/trajectory/shared';

export function registerTrajectoryTools(server: McpServer, getState: () => SessionManager) {
  // ── promptwheel_trajectory_list ────────────────────────────────────────────
  server.tool(
    'promptwheel_trajectory_list',
    'List all available trajectories and their status.',
    {},
    async () => {
      const state = getState();
      try {
        const trajectories = loadTrajectories(state.projectPath);
        const activeState = loadTrajectoryState(state.projectPath);

        const items = trajectories.map(t => {
          const isActive = activeState?.trajectoryName === t.name;
          const stepStates = isActive ? activeState.stepStates : {};
          const completedSteps = Object.values(stepStates).filter(s => s.status === 'completed').length;
          const totalSteps = t.steps.length;

          let status: string;
          if (isActive && activeState.paused) {
            status = 'paused';
          } else if (isActive) {
            status = 'active';
          } else {
            status = 'inactive';
          }

          return {
            name: t.name,
            description: t.description,
            stepCount: totalSteps,
            status,
            completedSteps,
            totalSteps,
          };
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ trajectories: items }, null, 2),
          }],
        };
      } catch (e) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: (e as Error).message }),
          }],
          isError: true,
        };
      }
    },
  );

  // ── promptwheel_trajectory_show ────────────────────────────────────────────
  server.tool(
    'promptwheel_trajectory_show',
    'Show full details of a trajectory including all steps and their status.',
    {
      name: z.string().describe('The trajectory name to show.'),
    },
    async (params) => {
      const state = getState();
      try {
        const trajectory = loadTrajectory(state.projectPath, params.name);
        if (!trajectory) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `Trajectory "${params.name}" not found` }),
            }],
            isError: true,
          };
        }

        const activeState = loadTrajectoryState(state.projectPath);
        const isActive = activeState?.trajectoryName === params.name;

        const steps = trajectory.steps.map(step => {
          const stepState = isActive ? activeState.stepStates[step.id] : undefined;
          return {
            id: step.id,
            title: step.title,
            description: step.description,
            scope: step.scope,
            categories: step.categories,
            acceptance_criteria: step.acceptance_criteria,
            verification_commands: step.verification_commands,
            depends_on: step.depends_on,
            max_retries: step.max_retries,
            measure: step.measure,
            status: stepState?.status ?? 'pending',
            cyclesAttempted: stepState?.cyclesAttempted ?? 0,
            lastAttemptedCycle: stepState?.lastAttemptedCycle ?? 0,
            failureReason: stepState?.failureReason,
            measurement: stepState?.measurement,
            completedAt: stepState?.completedAt,
          };
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              name: trajectory.name,
              description: trajectory.description,
              active: isActive,
              paused: isActive ? activeState.paused : false,
              currentStepId: isActive ? activeState.currentStepId : null,
              steps,
            }, null, 2),
          }],
        };
      } catch (e) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: (e as Error).message }),
          }],
          isError: true,
        };
      }
    },
  );

  // ── promptwheel_trajectory_activate ────────────────────────────────────────
  server.tool(
    'promptwheel_trajectory_activate',
    'Activate a trajectory. Creates initial step states and sets the first step as active.',
    {
      name: z.string().describe('The trajectory name to activate.'),
    },
    async (params) => {
      const state = getState();
      try {
        // Check existence first to distinguish not-found from cycle
        const existingTraj = loadTrajectory(state.projectPath, params.name);
        if (!existingTraj) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `Trajectory "${params.name}" not found` }),
            }],
            isError: true,
          };
        }

        const trajState = activateTrajectory(state.projectPath, params.name);
        if (!trajState) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `Cannot activate trajectory "${params.name}": circular dependency detected in steps` }),
            }],
            isError: true,
          };
        }

        const trajectory = loadTrajectory(state.projectPath, params.name);
        const currentStep = trajState.currentStepId && trajectory
          ? trajectory.steps.find(s => s.id === trajState.currentStepId)
          : null;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              activated: true,
              trajectory: params.name,
              currentStep: currentStep
                ? { id: currentStep.id, title: currentStep.title }
                : null,
            }, null, 2),
          }],
        };
      } catch (e) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: (e as Error).message }),
          }],
          isError: true,
        };
      }
    },
  );

  // ── promptwheel_trajectory_pause ───────────────────────────────────────────
  server.tool(
    'promptwheel_trajectory_pause',
    'Pause the currently active trajectory. The session continues but ignores trajectory steps.',
    {},
    async () => {
      const state = getState();
      try {
        const trajState = loadTrajectoryState(state.projectPath);
        if (!trajState) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'No active trajectory to pause' }),
            }],
            isError: true,
          };
        }

        if (trajState.paused) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'Trajectory is already paused' }),
            }],
            isError: true,
          };
        }

        trajState.paused = true;
        saveTrajectoryState(state.projectPath, trajState);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              paused: true,
              trajectory: trajState.trajectoryName,
            }, null, 2),
          }],
        };
      } catch (e) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: (e as Error).message }),
          }],
          isError: true,
        };
      }
    },
  );

  // ── promptwheel_trajectory_resume ──────────────────────────────────────────
  server.tool(
    'promptwheel_trajectory_resume',
    'Resume a paused trajectory.',
    {},
    async () => {
      const state = getState();
      try {
        const trajState = loadTrajectoryState(state.projectPath);
        if (!trajState) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'No active trajectory to resume' }),
            }],
            isError: true,
          };
        }

        if (!trajState.paused) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'Trajectory is not paused' }),
            }],
            isError: true,
          };
        }

        trajState.paused = false;
        saveTrajectoryState(state.projectPath, trajState);

        const trajectory = loadTrajectory(state.projectPath, trajState.trajectoryName);
        const currentStep = trajState.currentStepId && trajectory
          ? trajectory.steps.find(s => s.id === trajState.currentStepId)
          : null;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              resumed: true,
              trajectory: trajState.trajectoryName,
              currentStep: currentStep
                ? { id: currentStep.id, title: currentStep.title }
                : null,
            }, null, 2),
          }],
        };
      } catch (e) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: (e as Error).message }),
          }],
          isError: true,
        };
      }
    },
  );

  // ── promptwheel_trajectory_skip ────────────────────────────────────────────
  // Delegates to heal_trajectory(action=skip). Kept for backward compat.
  server.tool(
    'promptwheel_trajectory_skip',
    'Skip a trajectory step. Marks it as skipped and advances to the next eligible step.',
    {
      step_id: z.string().describe('The step ID to skip.'),
    },
    async (params) => {
      const state = getState();
      try {
        const trajState = loadTrajectoryState(state.projectPath);
        if (!trajState) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No active trajectory' }) }], isError: true };
        }

        const trajectory = loadTrajectory(state.projectPath, trajState.trajectoryName);
        if (!trajectory) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Trajectory definition not found' }) }], isError: true };
        }

        const result = skipStep(trajectory, trajState, params.step_id);
        if (!result.skipped) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error }) }], isError: true };
        }

        saveTrajectoryState(state.projectPath, trajState);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ skipped: true, stepId: params.step_id, nextStep: result.nextStep }, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: (e as Error).message }) }], isError: true };
      }
    },
  );

  // ── promptwheel_trajectory_reset ───────────────────────────────────────────
  server.tool(
    'promptwheel_trajectory_reset',
    'Reset a trajectory, clearing all step state. The trajectory definition remains.',
    {
      name: z.string().describe('The trajectory name to reset.'),
    },
    async (params) => {
      const state = getState();
      try {
        const trajState = loadTrajectoryState(state.projectPath);

        // Only clear if the active trajectory matches the requested name
        if (trajState && trajState.trajectoryName === params.name) {
          clearTrajectoryState(state.projectPath);
        } else if (trajState && trajState.trajectoryName !== params.name) {
          // The requested trajectory isn't the active one — nothing to reset
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                reset: true,
                name: params.name,
                message: 'Trajectory was not active — no state to clear.',
              }, null, 2),
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              reset: true,
              name: params.name,
            }, null, 2),
          }],
        };
      } catch (e) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: (e as Error).message }),
          }],
          isError: true,
        };
      }
    },
  );

  // ── promptwheel_heal_trajectory ──────────────────────────────────────────
  server.tool(
    'promptwheel_heal_trajectory',
    'Diagnose and recover stuck trajectory steps. Actions: diagnose (default), skip, retry, force_complete.',
    {
      step_id: z.string().describe('The step ID to diagnose or heal.'),
      action: z.enum(['diagnose', 'skip', 'retry', 'force_complete']).optional()
        .describe('Action: diagnose (default), skip (mark skipped), retry (reset attempts), force_complete (mark completed).'),
    },
    async (params) => {
      const state = getState();
      try {
        const trajState = loadTrajectoryState(state.projectPath);
        if (!trajState) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: 'No active trajectory' }),
            }],
            isError: true,
          };
        }

        const stepState = trajState.stepStates[params.step_id];
        if (!stepState) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `Step "${params.step_id}" not found in trajectory` }),
            }],
            isError: true,
          };
        }

        const trajectory = loadTrajectory(state.projectPath, trajState.trajectoryName);
        const step = trajectory?.steps.find(s => s.id === params.step_id);
        const action = params.action ?? 'diagnose';

        // ── Diagnose ──
        if (action === 'diagnose') {
          const issues: string[] = [];
          const suggestions: string[] = [];

          if (stepState.status === 'completed') {
            issues.push('Step is already completed');
          } else if (stepState.status === 'skipped') {
            issues.push('Step was skipped');
          } else if (stepState.status === 'failed') {
            issues.push(`Step failed: ${stepState.failureReason ?? 'unknown reason'}`);
            suggestions.push('Use action "retry" to reset attempt counter, or "skip" to move past it');
          } else if (stepState.status === 'active' || stepState.status === 'pending') {
            const maxRetries = step?.max_retries ?? 3;
            if (stepState.cyclesAttempted >= maxRetries) {
              issues.push(`Stuck: ${stepState.cyclesAttempted}/${maxRetries} attempts exhausted`);
              suggestions.push('Use action "retry" to reset attempts, "skip" to bypass, or "force_complete" if work is done');
            }
            if (stepState.consecutiveFailures && stepState.consecutiveFailures >= 2) {
              issues.push(`${stepState.consecutiveFailures} consecutive verification failures`);
            }
            if (stepState.totalFailures && stepState.totalFailures >= maxRetries * 2) {
              issues.push(`Flaky: ${stepState.totalFailures} total failures (threshold: ${maxRetries * 2})`);
            }
            if (stepState.lastVerificationOutput) {
              issues.push(`Last verification output: ${stepState.lastVerificationOutput.slice(0, 500)}`);
            }
            if (issues.length === 0) {
              issues.push(`Step is ${stepState.status} (${stepState.cyclesAttempted}/${maxRetries} attempts)`);
            }
          }

          // Check global stuck detection
          if (trajectory) {
            const stuckId = trajectoryStuck(trajState.stepStates, undefined, trajectory.steps);
            if (stuckId === params.step_id) {
              issues.push('Detected as stuck by trajectoryStuck() — would be auto-failed on next advance');
            }
          }

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                step_id: params.step_id,
                title: step?.title ?? params.step_id,
                status: stepState.status,
                cyclesAttempted: stepState.cyclesAttempted,
                issues,
                suggestions,
              }, null, 2),
            }],
          };
        }

        // ── Skip (delegates to shared skipStep) ──
        if (action === 'skip') {
          const skipResult = skipStep(trajectory!, trajState, params.step_id);
          if (!skipResult.skipped) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: skipResult.error }) }],
              isError: true,
            };
          }
          // skipStep already advanced state — save and return
          saveTrajectoryState(state.projectPath, trajState);
          const isComplete = trajectory ? trajectoryComplete(trajectory, trajState.stepStates) : false;
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                action,
                step_id: params.step_id,
                title: step?.title ?? params.step_id,
                new_status: 'skipped',
                nextStep: skipResult.nextStep,
                trajectory_complete: isComplete,
              }, null, 2),
            }],
          };
        }

        // ── Retry ──
        if (action === 'retry') {
          if (stepState.status === 'completed' || stepState.status === 'skipped') {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ error: `Cannot retry a ${stepState.status} step` }),
              }],
              isError: true,
            };
          }
          stepState.status = 'active';
          stepState.cyclesAttempted = 0;
          stepState.consecutiveFailures = 0;
          stepState.failureReason = undefined;
          stepState.lastVerificationOutput = undefined;
        }

        // ── Force complete ──
        if (action === 'force_complete') {
          stepState.status = 'completed';
          stepState.completedAt = Date.now();
        }

        // Advance to next step after force_complete (skip returns early above)
        let nextStep: { id: string; title: string } | null = null;
        if (trajectory && action === 'force_complete') {
          const next = getNextStep(trajectory, trajState.stepStates);
          if (next) {
            trajState.stepStates[next.id].status = 'active';
            trajState.currentStepId = next.id;
            nextStep = { id: next.id, title: next.title };
          } else {
            trajState.currentStepId = null;
          }
        }

        // For retry, keep current step as active
        if (action === 'retry') {
          trajState.currentStepId = params.step_id;
        }

        saveTrajectoryState(state.projectPath, trajState);

        const isComplete = trajectory ? trajectoryComplete(trajectory, trajState.stepStates) : false;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              action,
              step_id: params.step_id,
              title: step?.title ?? params.step_id,
              new_status: stepState.status,
              nextStep,
              trajectory_complete: isComplete,
            }, null, 2),
          }],
        };
      } catch (e) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: (e as Error).message }),
          }],
          isError: true,
        };
      }
    },
  );
}
