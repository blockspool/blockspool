/**
 * Proposal filtering, balancing, and ranking logic for solo-auto mode.
 *
 * Pure algorithm lives in @blockspool/core/proposals/shared.
 * This file re-exports it for CLI consumers.
 */

export { balanceProposals } from '@blockspool/core/proposals/shared';
