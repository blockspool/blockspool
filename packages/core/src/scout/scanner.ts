/**
 * File scanner - Discovers and reads files for analysis
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * File info with content
 */
export interface ScannedFile {
  path: string;
  content: string;
  size: number;
}

/**
 * Options for file scanning
 */
export interface ScanOptions {
  /** Base directory */
  cwd: string;
  /** Glob-like patterns to include */
  include: string[];
  /** Glob-like patterns to exclude */
  exclude?: string[];
  /** Maximum file size in bytes (default: 100KB) */
  maxFileSize?: number;
  /** Maximum total files (default: 500) */
  maxFiles?: number;
}

/**
 * Default exclusion patterns
 */
const DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
  '*.min.js',
  '*.map',
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

/**
 * Check if a path matches a simple glob pattern
 *
 * Supports:
 * - ** for recursive matching
 * - * for single segment matching
 * - Direct path matching
 */
function matchesPattern(filePath: string, pattern: string): boolean {
  // Normalize paths
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  // Direct match
  if (normalizedPath === normalizedPattern) {
    return true;
  }

  // Check if pattern is a directory prefix (without glob)
  if (!normalizedPattern.includes('*') && normalizedPath.startsWith(normalizedPattern + '/')) {
    return true;
  }

  // Simple glob matching
  if (normalizedPattern.includes('*')) {
    // Escape regex special chars except *
    const escaped = normalizedPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&');

    // Convert glob patterns to regex
    // Note: **/ should be optional to match files directly in the directory
    // e.g., src/services/**/*.ts should match both src/services/auditor.ts
    // and src/services/sub/file.ts
    const regexPattern = escaped
      .replace(/\*\*\//g, '<<<DOUBLESTARSLASH>>>')
      .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<<DOUBLESTARSLASH>>>/g, '(.*\\/)?')
      .replace(/<<<DOUBLESTAR>>>/g, '.*');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(normalizedPath);
  }

  return false;
}

/**
 * Check if a path should be excluded
 */
function shouldExclude(filePath: string, excludePatterns: string[]): boolean {
  const allExcludes = [...DEFAULT_EXCLUDES, ...excludePatterns];

  for (const pattern of allExcludes) {
    if (matchesPattern(filePath, pattern)) {
      return true;
    }
    // Also check if any path segment matches (for things like node_modules)
    const segments = filePath.split('/');
    if (segments.some(seg => matchesPattern(seg, pattern))) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a file matches any include pattern
 */
function shouldInclude(filePath: string, includePatterns: string[]): boolean {
  // If no patterns specified, include source-like files
  if (includePatterns.length === 0) {
    const ext = path.extname(filePath).toLowerCase();
    return ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.md'].includes(ext);
  }

  return includePatterns.some(pattern => matchesPattern(filePath, pattern));
}

/**
 * Recursively scan directory for files
 */
function walkDir(
  dir: string,
  baseDir: string,
  options: ScanOptions,
  files: ScannedFile[]
): void {
  const maxFileSize = options.maxFileSize ?? 100 * 1024; // 100KB
  const maxFiles = options.maxFiles ?? 500;

  if (files.length >= maxFiles) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // Skip unreadable directories
  }

  for (const entry of entries) {
    if (files.length >= maxFiles) {
      break;
    }

    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    // Check exclusions first
    if (shouldExclude(relativePath, options.exclude ?? [])) {
      continue;
    }

    if (entry.isDirectory()) {
      walkDir(fullPath, baseDir, options, files);
    } else if (entry.isFile()) {
      // Check inclusion
      if (!shouldInclude(relativePath, options.include)) {
        continue;
      }

      // Check file size
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > maxFileSize) {
          continue;
        }

        // Read content
        const content = fs.readFileSync(fullPath, 'utf-8');
        files.push({
          path: relativePath,
          content,
          size: stat.size,
        });
      } catch {
        // Skip unreadable files
      }
    }
  }
}

/**
 * Scan a directory for files matching the given patterns
 */
export function scanFiles(options: ScanOptions): ScannedFile[] {
  const files: ScannedFile[] = [];
  walkDir(options.cwd, options.cwd, options, files);
  return files;
}

/**
 * Group files into batches for processing
 */
export function batchFiles(files: ScannedFile[], batchSize: number = 3): ScannedFile[][] {
  const batches: ScannedFile[][] = [];

  for (let i = 0; i < files.length; i += batchSize) {
    batches.push(files.slice(i, i + batchSize));
  }

  return batches;
}
