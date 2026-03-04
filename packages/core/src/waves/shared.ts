/**
 * Wave scheduling shared algorithms — barrel re-export.
 *
 * All implementations live in conflict.ts — conflict detection, path helpers,
 * and wave partitioning.
 */

export {
  // Types
  type ConflictSensitivity,
  type ConflictDetectionOptions,

  // Constants
  CONFLICT_PRONE_FILENAMES,
  SHARED_DIRECTORY_PATTERNS,
  PACKAGE_PATTERN,
  DIRECTORY_OVERLAP_NORMAL,
  DIRECTORY_OVERLAP_STRICT,

  // Path helpers
  parsePath,
  pathsOverlap,
  directoriesOverlap,

  // Conflict detection helpers
  isConflictProneFile,
  isInSharedDirectory,
  getDirectories,
  hasSiblingFiles,
  hasConflictProneOverlap,
  hasSharedParentConflict,
  touchesSamePackage,

  // Main conflict detection
  proposalsConflict,

  // Wave partitioning
  partitionIntoWaves,
} from './conflict.js';
