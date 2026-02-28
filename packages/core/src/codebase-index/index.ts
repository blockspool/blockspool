/**
 * Pre-Scout Codebase Index — lightweight structural map built at session start.
 *
 * Walks directories 2 levels deep using `fs` only. No AST parsing, no heavy deps.
 * Provides module map, dependency edges, test gaps, complexity hotspots, and entrypoints.
 *
 * Pure algorithms (classification, import extraction, formatting) live in ./shared.ts.
 * This file provides the I/O-heavy functions that use the filesystem and git.
 *
 * Single source of truth — imported by both @promptwheel/cli and @promptwheel/mcp.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

// Re-export AST analysis types
export { type AstGrepModule } from './ast-analysis.js';
export { mapExtensionToLang, analyzeFileAst, extractTopLevelSymbols, extractCallEdges, extractImportedNames } from './ast-analysis.js';
export { loadAstCache, type AstCache, type AstCacheEntry } from './ast-cache.js';

// Re-export everything from shared (pure algorithms + types + constants)
export {
  type CodebaseIndex,
  type ClassificationConfidence,
  type ModuleEntry,
  type LargeFileEntry,
  type ClassifyResult,
  type GraphMetrics,
  type ExportEntry,
  type AstAnalysisResult,
  type AstFinding,
  type AstFindingEntry,
  type SymbolRange,
  type CallEdge,
  type DeadExportEntry,
  type StructuralIssue,
  type TypeScriptAnalysis,
  SOURCE_EXTENSIONS,
  PURPOSE_HINT,
  NON_PRODUCTION_PURPOSES,
  CHUNK_SIZE,
  purposeHintFromDirName,
  sampleEvenly,
  countNonProdFiles,
  classifyModule,
  extractImports,
  resolveImportToModule,
  formatIndexForPrompt,
  computeReverseEdges,
  detectCycles,
  computeGraphMetrics,
} from './shared.js';

// Import for local use
import type { CodebaseIndex, ModuleEntry, LargeFileEntry, ExportEntry, AstFindingEntry } from './shared.js';
import {
  SOURCE_EXTENSIONS,
  sampleEvenly,
  classifyModule,
  extractImports,
  resolveImportToModule,
  computeReverseEdges,
  detectCycles,
  computeGraphMetrics,
} from './shared.js';
import type { AstGrepModule as AstGrepModuleType } from './ast-analysis.js';
import { analyzeFileAst, mapExtensionToLang, extractTopLevelSymbols, extractCallEdges, extractImportedNames } from './ast-analysis.js';
import { loadAstCache, saveAstCache, isEntryCurrent, isFindingsCurrent, type AstCache } from './ast-cache.js';
import { detectDeadExports, detectDeadFunctionsFused, detectStructuralIssues } from './dead-code.js';
import { getPatterns, scanPatterns, FINDINGS_VERSION, getPatternVersions, arePatternVersionsCurrent } from './ast-patterns.js';
import { getLangFamily } from './ast-analysis.js';

// Re-export format-analysis
export { formatAnalysisForPrompt } from './format-analysis.js';

// Re-export dead code analysis utilities for consumers with ts-morph data
export { fuseCallGraphs, detectDeadFunctionsFused } from './dead-code.js';

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

/**
 * Read a short header snippet from a file (first 512 bytes, ~12 lines).
 * Cheaper than the full 4KB read used for import scanning.
 */
function readHeader(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, bytesRead);
  } catch {
    return null;
  }
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Git-aware directory filtering
// ---------------------------------------------------------------------------

/**
 * Use `git ls-files` to discover which top-level directories contain tracked
 * (or unignored) files. Returns null if git is unavailable or the project
 * is not a git repo — callers should fall back to hardcoded excludes.
 */
export function getTrackedDirectories(projectRoot: string): Set<string> | null {
  try {
    const stdout = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: projectRoot, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8',
    });
    const dirs = new Set<string>();
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      const parts = line.split('/');
      if (parts.length > 1) dirs.add(parts[0]);
    }
    return dirs;
  } catch {
    return null; // Not a git repo or git not available
  }
}

/** Max modules to discover. Prevents unbounded scanning in large monorepos. */
const MAX_MODULES = 80;

// ---------------------------------------------------------------------------
// buildCodebaseIndex
// ---------------------------------------------------------------------------

export function buildCodebaseIndex(
  projectRoot: string,
  excludeDirs: string[] = [],
  useGitTracking = true,
  astGrepModule?: AstGrepModuleType | null,
): CodebaseIndex {
  const excludeSet = new Set(excludeDirs.map(d => d.toLowerCase()));

  // Git-aware filtering: only walk directories that contain tracked files
  const trackedDirs = useGitTracking ? getTrackedDirectories(projectRoot) : null;

  // Step 1: Module map — walk dirs 2 levels deep
  const modules: ModuleEntry[] = [];
  const sourceFilesByModule = new Map<string, string[]>();

  function shouldExclude(name: string): boolean {
    if (excludeSet.has(name.toLowerCase()) || name.startsWith('.')) return true;
    return false;
  }

  function walkForModules(dir: string, depth: number): void {
    if (modules.length >= MAX_MODULES) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const sourceFiles: string[] = [];
    const subdirs: fs.Dirent[] = [];

    for (const entry of entries) {
      if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        sourceFiles.push(path.join(dir, entry.name));
      } else if (entry.isDirectory() && !shouldExclude(entry.name)) {
        // At depth 0 (project root), skip directories not tracked by git
        if (depth === 0 && trackedDirs && !trackedDirs.has(entry.name)) {
          continue;
        }
        subdirs.push(entry);
      }
    }

    // Register this dir as a module if it has source files
    if (sourceFiles.length > 0 && depth > 0) {
      const relPath = path.relative(projectRoot, dir);
      if (relPath && modules.length < MAX_MODULES) {
        // Placeholder — classified after import scanning (Step 2)
        modules.push({
          path: relPath,
          file_count: sourceFiles.length,
          production_file_count: sourceFiles.length,
          purpose: 'unknown',
          production: true,
          classification_confidence: 'low',
        });
        sourceFilesByModule.set(relPath, sourceFiles);
      }
    }

    // Recurse into subdirs (up to depth 2)
    if (depth < 3) {
      for (const sub of subdirs) {
        if (modules.length >= MAX_MODULES) break;
        walkForModules(path.join(dir, sub.name), depth + 1);
      }
    }
  }

  walkForModules(projectRoot, 0);

  const moduleCapHit = modules.length >= MAX_MODULES;
  if (moduleCapHit) {
    console.warn(`[promptwheel] Module cap hit: discovered ${modules.length} modules (max ${MAX_MODULES}). Some modules may be excluded from analysis. Use \`scope\` to narrow the scan.`);
  }

  const modulePaths = modules.map(m => m.path);

  // Step 2: Import scanning + content sampling — build dependency_edges, classify modules
  const dependencyEdges: Record<string, string[]> = {};
  const sampledFileMtimes: Record<string, number> = {};
  const contentByModule = new Map<string, string[]>();

  for (const mod of modules) {
    const files = sourceFilesByModule.get(mod.path) ?? [];
    const deps = new Set<string>();
    const snippets: string[] = [];

    // Sample up to 5 files evenly for full import scanning (4KB read)
    const filesToScan = sampleEvenly(files, 5);
    for (const filePath of filesToScan) {
      try {
        // Record mtime for change detection
        const relFile = path.relative(projectRoot, filePath);
        sampledFileMtimes[relFile] = fs.statSync(filePath).mtimeMs;

        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
        fs.closeSync(fd);
        // Skip binary files (check for null bytes in first 512 bytes of actual content)
        const checkLen = Math.min(bytesRead, 512);
        if (checkLen > 0 && buf.subarray(0, checkLen).indexOf(0) !== -1) continue;
        const content = buf.toString('utf8', 0, bytesRead);
        // Trim to ~50 lines
        const lines = content.split('\n').slice(0, 50).join('\n');
        snippets.push(lines);

        const imports = extractImports(lines, filePath);
        for (const spec of imports) {
          const resolved = resolveImportToModule(spec, filePath, projectRoot, modulePaths);
          if (resolved && resolved !== mod.path) {
            deps.add(resolved);
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    // Sample additional files for classification (header-only, 512B — cheap)
    const scannedSet = new Set(filesToScan);
    const extraFiles = sampleEvenly(files.filter(f => !scannedSet.has(f)), 10);
    for (const filePath of extraFiles) {
      const header = readHeader(filePath);
      if (header) snippets.push(header);
    }

    contentByModule.set(mod.path, snippets);

    if (deps.size > 0) {
      dependencyEdges[mod.path] = [...deps];
    }
  }

  // Step 2b: Classify modules using ALL file names + sampled content
  for (const mod of modules) {
    const files = sourceFilesByModule.get(mod.path) ?? [];
    const allFileNames = files.map(f => path.basename(f));
    const snippets = contentByModule.get(mod.path) ?? [];
    const { purpose, production, productionFileCount, confidence } = classifyModule(
      path.basename(path.join(projectRoot, mod.path)), allFileNames, snippets, mod.file_count,
    );
    mod.purpose = purpose;
    mod.production = production;
    mod.production_file_count = productionFileCount;
    mod.classification_confidence = confidence;
  }

  // Step 2c: AST analysis — when ast-grep is available, extract exports and complexity
  let analysisBackend: 'regex' | 'ast-grep' = 'regex';
  const allFindings: AstFindingEntry[] = [];
  if (astGrepModule) {
    analysisBackend = 'ast-grep';
    const astCache = loadAstCache(projectRoot);
    const updatedCache: AstCache = { ...astCache };
    const allCurrentFiles = new Set<string>();
    const patterns = getPatterns();

    // Per-module: aggregate exports and complexity from individual files
    for (const mod of modules) {
      const files = sourceFilesByModule.get(mod.path) ?? [];
      const moduleExports: ExportEntry[] = [];
      let totalComplexity = 0;
      let filesAnalyzed = 0;

      for (const filePath of files) {
        const relFile = path.relative(projectRoot, filePath);
        allCurrentFiles.add(relFile);
        const ext = path.extname(filePath);
        const langKey = mapExtensionToLang(ext);
        if (!langKey) continue;

        // Check cache first
        let stat: fs.Stats;
        try { stat = fs.statSync(filePath); } catch { continue; }
        const cached = updatedCache[relFile];

        if (isEntryCurrent(cached, stat.mtimeMs, stat.size)) {
          // File unchanged — reuse imports/exports/complexity from cache
          moduleExports.push(...cached.exports);
          totalComplexity += cached.complexity;
          filesAnalyzed++;

          const langFamily = getLangFamily(langKey);
          const patternsCurrent = arePatternVersionsCurrent(cached.patternVersions, langFamily)
            || isFindingsCurrent(cached, FINDINGS_VERSION); // fallback for pre-patternVersions cache
          if (patternsCurrent) {
            // State A: unchanged + findings current → full cache hit
            if (cached.findings) {
              for (const f of cached.findings) {
                allFindings.push({ file: relFile, patternId: f.patternId, message: f.message, line: f.line, severity: f.severity, category: f.category });
              }
            }
            // Lazy backfill: populate symbols if missing from older cache entries
            if (!cached.symbols) {
              try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const symbols = extractTopLevelSymbols(content, langKey, astGrepModule);
                if (symbols) {
                  updatedCache[relFile] = { ...cached, symbols };
                }
              } catch { /* non-fatal */ }
            }
          } else {
            // State B: unchanged + findings stale → re-parse for patterns (+ symbols if missing)
            try {
              const content = fs.readFileSync(filePath, 'utf-8');
              const langId = astGrepModule.Lang[langKey];
              if (langId) {
                const root = astGrepModule.parse(langId, content).root();
                // Backfill symbols and importedNames while we have the content loaded
                const symbols = cached.symbols ?? extractTopLevelSymbols(content, langKey, astGrepModule) ?? undefined;
                const importedNames = cached.importedNames ?? (extractImportedNames(root, langKey) || undefined);
                const findings = scanPatterns(root, langKey, content, patterns, symbols);
                const storedFindings = findings.length > 0 ? findings : undefined;
                updatedCache[relFile] = {
                  ...cached,
                  findings: storedFindings,
                  findingsVersion: FINDINGS_VERSION,
                  patternVersions: getPatternVersions(),
                  symbols,
                  importedNames: importedNames?.length ? importedNames : undefined,
                };
                if (storedFindings) {
                  for (const f of storedFindings) {
                    allFindings.push({ file: relFile, patternId: f.patternId, message: f.message, line: f.line, severity: f.severity, category: f.category });
                  }
                }
              }
            } catch {
              // Re-parse error — keep cached imports/exports/complexity, skip findings
            }
          }
          continue;
        }

        // State C: file changed → full re-parse with patterns + symbols
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          // Extract symbols first so pattern scanning can attribute findings to functions
          const symbols = extractTopLevelSymbols(content, langKey, astGrepModule) ?? undefined;
          const result = analyzeFileAst(content, filePath, langKey, astGrepModule, patterns, symbols);
          if (result) {
            moduleExports.push(...result.exports);
            totalComplexity += result.complexity;
            filesAnalyzed++;
            const storedFindings = result.findings && result.findings.length > 0 ? result.findings : undefined;
            const callEdges = extractCallEdges(content, langKey, astGrepModule, symbols) ?? undefined;
            updatedCache[relFile] = {
              mtime: stat.mtimeMs,
              size: stat.size,
              imports: result.imports,
              exports: result.exports,
              complexity: result.complexity,
              findings: storedFindings,
              findingsVersion: FINDINGS_VERSION,
              patternVersions: getPatternVersions(),
              symbols,
              callEdges: callEdges?.length ? callEdges : undefined,
              importedNames: result.importedNames,
            };
            if (storedFindings) {
              for (const f of storedFindings) {
                allFindings.push({ file: relFile, patternId: f.patternId, message: f.message, line: f.line, severity: f.severity, category: f.category });
              }
            }
          }
        } catch {
          // File read error — skip this file for AST analysis
        }
      }

      // Populate module-level AST metrics
      if (filesAnalyzed > 0) {
        mod.export_count = moduleExports.length;
        mod.exported_names = moduleExports.slice(0, 20).map(e => e.name);
        mod.avg_complexity = totalComplexity / filesAnalyzed;
      }
    }

    // Save updated cache (pruning stale entries)
    saveAstCache(projectRoot, updatedCache, allCurrentFiles);
  }

  // Step 3: Test coverage — find untested modules
  const untestedModules: string[] = [];

  for (const mod of modules) {
    if (mod.purpose === 'tests') continue;

    const modAbsPath = path.join(projectRoot, mod.path);
    const modParent = path.dirname(modAbsPath);

    let hasTesting = false;

    if (existsDir(path.join(modAbsPath, '__tests__'))) {
      hasTesting = true;
    }

    if (!hasTesting && (existsDir(path.join(modParent, 'test')) || existsDir(path.join(modParent, 'tests')))) {
      hasTesting = true;
    }

    if (!hasTesting) {
      const files = sourceFilesByModule.get(mod.path) ?? [];
      hasTesting = files.some(f => {
        const base = path.basename(f);
        return base.includes('.test.') || base.includes('.spec.');
      });
    }

    if (!hasTesting) {
      untestedModules.push(mod.path);
    }
  }

  // Step 4: Large files — stat.size / 40 heuristic for LOC
  const largeFiles: LargeFileEntry[] = [];

  for (const mod of modules) {
    const files = sourceFilesByModule.get(mod.path) ?? [];
    for (const filePath of files) {
      if (largeFiles.length >= 20) break;
      try {
        const stat = fs.statSync(filePath);
        // Heuristic: ~45 bytes/line for code (accounts for indentation)
        const estimatedLines = Math.round(stat.size / 45);
        if (estimatedLines > 300) {
          largeFiles.push({
            path: path.relative(projectRoot, filePath),
            lines: estimatedLines,
          });
        }
      } catch {
        // skip
      }
    }
    if (largeFiles.length >= 20) break;
  }

  // Step 5: Entrypoints
  const entrypoints: string[] = [];
  const entrypointNames = [
    'index.ts', 'index.js', 'main.ts', 'main.js',
    'app.ts', 'app.js', 'server.ts', 'server.js',
    'main.py', 'app.py', 'manage.py', 'wsgi.py',
    'main.go',
    'main.rs', 'lib.rs',
    'index.php', 'artisan',
    'main.swift',
    'main.rb', 'config/application.rb',
    'main.ex', 'lib.ex',
    'main.dart', 'lib/main.dart',
    'Main.java', 'Application.java',
    'Program.cs', 'Main.cs',          // C#
    'Main.scala',                      // Scala
    'main.c', 'main.cpp',
    'Main.hs',
    'main.zig',
  ];

  const searchDirs = [projectRoot, path.join(projectRoot, 'src'), path.join(projectRoot, 'cmd')];
  for (const dir of searchDirs) {
    for (const name of entrypointNames) {
      if (entrypoints.length >= 10) break;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) {
          entrypoints.push(path.relative(projectRoot, full));
        }
      } catch {
        // doesn't exist
      }
    }
  }

  // Step 6: Graph analysis — reverse edges, cycle detection, topology metrics
  const reverseEdges = computeReverseEdges(dependencyEdges);
  const dependencyCycles = detectCycles(dependencyEdges);
  const graphMetrics = computeGraphMetrics(modules, dependencyEdges, reverseEdges);

  // Populate per-module fan_in / fan_out
  for (const mod of modules) {
    mod.fan_in = (reverseEdges[mod.path] ?? []).length;
    mod.fan_out = (dependencyEdges[mod.path] ?? []).length;
  }

  // Step 7: Dead code + structural analysis
  // Dead exports require AST data (exportsByModule). Structural issues use graph metrics.
  let deadExports: import('./shared.js').DeadExportEntry[] | undefined;
  let callEdgeSummaries: Record<string, string[]> | undefined;

  if (analysisBackend === 'ast-grep') {
    // Build per-module export/import maps from AST cache
    const exportsByModule: Record<string, ExportEntry[]> = {};
    const importsByModule: Record<string, string[]> = {};
    for (const mod of modules) {
      if (mod.exported_names && mod.exported_names.length > 0) {
        // Reconstruct ExportEntry from module data (kind is lost, use 'other')
        exportsByModule[mod.path] = mod.exported_names.map(name => ({ name, kind: 'other' as const }));
      }
      // Use dependency edges as import proxy
      const deps = dependencyEdges[mod.path];
      if (deps) importsByModule[mod.path] = deps;
    }

    // Collect actual imported binding names from AST cache (more accurate than specifiers)
    const cachedData = loadAstCache(projectRoot);
    const allImportedBindings = new Set<string>();
    const namespaceSpecifiers = new Set<string>();
    for (const entry of Object.values(cachedData)) {
      if (entry.importedNames) {
        for (const name of entry.importedNames) {
          if (name.startsWith('*:')) {
            namespaceSpecifiers.add(name.slice(2)); // track namespace import specifiers
          } else {
            allImportedBindings.add(name);
          }
        }
      }
    }
    deadExports = detectDeadExports(
      modules, dependencyEdges, exportsByModule, importsByModule,
      30,
      allImportedBindings.size > 0 ? allImportedBindings : undefined,
      namespaceSpecifiers.size > 0 ? namespaceSpecifiers : undefined,
    );

    // Fused dead function detection: collect per-file call edges and exports from AST cache
    const exportsByFile: Record<string, ExportEntry[]> = {};
    const callEdgesByFile: Record<string, import('./shared.js').CallEdge[]> = {};
    for (const [relFile, entry] of Object.entries(cachedData)) {
      if (entry.exports?.length) exportsByFile[relFile] = entry.exports;
      if (entry.callEdges?.length) callEdgesByFile[relFile] = entry.callEdges;
    }
    if (Object.keys(callEdgesByFile).length > 0) {
      const deadFns = detectDeadFunctionsFused(exportsByFile, callEdgesByFile, undefined, 20);
      // Merge into deadExports, avoiding duplicates by name
      if (deadFns.length > 0) {
        const existingNames = new Set((deadExports ?? []).map(d => `${d.module}:${d.name}`));
        for (const fn of deadFns) {
          if (!existingNames.has(`${fn.module}:${fn.name}`)) {
            (deadExports ??= []).push(fn);
          }
        }
      }
    }

    // Build per-module cross-file call summaries for focus modules
    // Format: "funcA calls importedB, importedC" (only cross-file calls with importSource)
    if (Object.keys(callEdgesByFile).length > 0) {
      const modCallSummaries: Record<string, string[]> = {};
      for (const mod of modules) {
        const summaryLines: string[] = [];
        // Find files in this module
        const modPrefix = mod.path + '/';
        for (const [relFile, edges] of Object.entries(callEdgesByFile)) {
          if (!relFile.startsWith(modPrefix)) continue;
          // Group cross-file calls by caller
          const callerMap = new Map<string, Set<string>>();
          for (const edge of edges) {
            if (!edge.importSource) continue;
            const callees = callerMap.get(edge.caller) ?? new Set();
            callees.add(edge.callee);
            callerMap.set(edge.caller, callees);
          }
          for (const [caller, callees] of callerMap) {
            const calleeList = [...callees].slice(0, 5);
            const suffix = callees.size > 5 ? ` (+${callees.size - 5} more)` : '';
            summaryLines.push(`${caller} calls ${calleeList.join(', ')}${suffix}`);
          }
        }
        if (summaryLines.length > 0) {
          modCallSummaries[mod.path] = summaryLines.slice(0, 10); // cap per module
        }
      }
      if (Object.keys(modCallSummaries).length > 0) {
        callEdgeSummaries = modCallSummaries;
      }
    }
  }

  // Structural issues only need graph data (no AST required)
  const structuralIssues = detectStructuralIssues(modules, dependencyEdges, reverseEdges, dependencyCycles, entrypoints);

  return {
    built_at: new Date().toISOString(),
    modules,
    dependency_edges: dependencyEdges,
    reverse_edges: reverseEdges,
    dependency_cycles: dependencyCycles,
    graph_metrics: graphMetrics,
    untested_modules: untestedModules,
    large_files: largeFiles,
    entrypoints,
    sampled_file_mtimes: sampledFileMtimes,
    analysis_backend: analysisBackend,
    dead_exports: deadExports,
    structural_issues: structuralIssues,
    ast_findings: allFindings.length > 0 ? allFindings : undefined,
    module_cap_hit: moduleCapHit || undefined,
    call_edge_summaries: callEdgeSummaries,
  };
}

// ---------------------------------------------------------------------------
// refreshCodebaseIndex
// ---------------------------------------------------------------------------

export function refreshCodebaseIndex(
  _existing: CodebaseIndex,
  projectRoot: string,
  excludeDirs: string[] = [],
  useGitTracking = true,
  astGrepModule?: AstGrepModuleType | null,
): CodebaseIndex {
  return buildCodebaseIndex(projectRoot, excludeDirs, useGitTracking, astGrepModule);
}

// ---------------------------------------------------------------------------
// hasStructuralChanges
// ---------------------------------------------------------------------------

export function hasStructuralChanges(
  index: CodebaseIndex,
  projectRoot: string,
): boolean {
  const builtAt = new Date(index.built_at).getTime();

  const dirsToCheck = new Set<string>();

  for (const mod of index.modules) {
    const absPath = path.join(projectRoot, mod.path);
    dirsToCheck.add(absPath);
    dirsToCheck.add(path.dirname(absPath));
  }

  dirsToCheck.add(projectRoot);
  dirsToCheck.add(path.join(projectRoot, 'src'));

  for (const dir of dirsToCheck) {
    try {
      if (fs.statSync(dir).mtimeMs > builtAt) {
        return true;
      }
    } catch {
      const rel = path.relative(projectRoot, dir);
      if (index.modules.some(m => m.path === rel)) {
        return true;
      }
    }
  }

  for (const [relFile, oldMtime] of Object.entries(index.sampled_file_mtimes)) {
    try {
      const currentMtime = fs.statSync(path.join(projectRoot, relFile)).mtimeMs;
      if (currentMtime !== oldMtime) {
        return true;
      }
    } catch {
      return true;
    }
  }

  return false;
}
