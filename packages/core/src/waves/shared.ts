/**
 * Wave scheduling shared algorithms — barrel re-export.
 *
 * All implementations live in focused submodules:
 * - conflict.ts — conflict detection, path helpers, wave partitioning
 * - merge.ts — symbol enrichment, merge prediction, structural merge, scout escalation
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
  hasImportChainConflict,
  hasCallGraphConflict,
  proposalsConflict,

  // Wave partitioning
  partitionIntoWaves,
} from './conflict.js';

export {
  // Symbol enrichment
  type SymbolMap,
  enrichWithSymbols,

  // Merge prediction
  predictMergeConflict,
  orderMergeSequence,

  // Scout escalation
  buildScoutEscalation,

  // Structural merge
  tryStructuralMerge,
} from './merge.js';
