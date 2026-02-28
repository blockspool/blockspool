/**
 * Trajectory I/O — re-exports from @promptwheel/core/trajectory/io.
 *
 * All trajectory file I/O is now consolidated in core. This module exists
 * for backward compatibility with existing imports in the MCP package.
 */

export {
  loadTrajectories,
  loadTrajectory,
  loadTrajectoryState,
  saveTrajectoryState,
  clearTrajectoryState,
  activateTrajectory,
  loadTrajectoryData,
  completeTrajectory,
  abandonTrajectory,
} from '@promptwheel/core/trajectory/io';
