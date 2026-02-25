/**
 * TypeScript-specific semantic analysis via ts-morph.
 *
 * Strictly optional — returns null when ts-morph is unavailable or no tsconfig
 * is found. Loaded via dynamic import to avoid adding weight to non-TS projects.
 *
 * All ts-morph types are accessed dynamically (no static `import type`) so
 * the CLI compiles even when ts-morph is not installed.
 *
 * Detects:
 * - `any` type usage + propagation chains
 * - Function-level call graph edges
 * - API surface (public export count per module)
 * - Unchecked type assertions (`as X`, non-null `!`)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TypeScriptAnalysis, ModuleEntry } from '@promptwheel/core/codebase-index';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze TypeScript project using ts-morph for deep semantic insights.
 *
 * @param repoRoot - Repository root directory
 * @param modules - Codebase index modules to analyze
 * @param timeoutMs - Maximum analysis time (default: 30s)
 * @returns TypeScriptAnalysis or null if ts-morph unavailable or no tsconfig
 */
export async function analyzeTypeScript(
  repoRoot: string,
  modules: ModuleEntry[],
  timeoutMs = 30_000,
): Promise<TypeScriptAnalysis | null> {
  // 1. Find tsconfig.json
  const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return null;

  // 2. Dynamic import ts-morph — use variable specifier to avoid TS2307
  //    when ts-morph is not installed (it's an optional dependency)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tsMorph: any;
  try {
    const moduleName = 'ts-morph';
    tsMorph = await import(/* webpackIgnore: true */ moduleName);
  } catch {
    return null; // ts-morph not installed
  }

  // 3. Run analysis with timeout
  return Promise.race([
    runAnalysis(tsMorph, tsconfigPath, repoRoot, modules),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

// ---------------------------------------------------------------------------
// Internal analysis
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runAnalysis(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tsMorph: any,
  tsconfigPath: string,
  repoRoot: string,
  modules: ModuleEntry[],
): Promise<TypeScriptAnalysis> {
  const { Project, SyntaxKind } = tsMorph;

  const project = new Project({
    tsConfigFilePath: tsconfigPath,
    skipAddingFilesFromTsConfig: true,
  });

  // Add only production module files (cap at 500 files to avoid OOM)
  const prodModules = modules.filter(m => m.production);
  const filesToAdd: string[] = [];

  for (const mod of prodModules) {
    const modDir = path.join(repoRoot, mod.path);
    if (!fs.existsSync(modDir)) continue;
    try {
      const entries = fs.readdirSync(modDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (/\.(test|spec|e2e|stories?)\./i.test(entry.name)) continue;
        filesToAdd.push(path.join(modDir, entry.name));
        if (filesToAdd.length >= 500) break;
      }
    } catch {
      continue;
    }
    if (filesToAdd.length >= 500) break;
  }

  for (const f of filesToAdd) {
    project.addSourceFileAtPath(f);
  }

  const sourceFiles = project.getSourceFiles();

  let anyCount = 0;
  let uncheckedTypeAssertions = 0;
  const callEdges: Array<{ caller: string; callee: string }> = [];
  const apiSurface: Record<string, number> = {};
  const anyLocations: Array<{ file: string; name: string }> = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const sf of sourceFiles as any[]) {
    const relPath = path.relative(repoRoot, sf.getFilePath());
    const modPath = relPath.split('/').slice(0, -1).join('/');

    // Count `any` type annotations
    const typeRefs = sf.getDescendantsOfKind(SyntaxKind.AnyKeyword);
    anyCount += typeRefs.length;
    if (typeRefs.length > 0 && anyLocations.length < 50) {
      // Track which functions contain `any`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const ref of typeRefs.slice(0, 5) as any[]) {
        const fn = ref.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration)
          ?? ref.getFirstAncestorByKind(SyntaxKind.MethodDeclaration)
          ?? ref.getFirstAncestorByKind(SyntaxKind.ArrowFunction);
        const name = fn?.getName?.() ?? '<anonymous>';
        anyLocations.push({ file: relPath, name: name || relPath });
      }
    }

    // Count type assertions (`as X`)
    const asExpressions = sf.getDescendantsOfKind(SyntaxKind.AsExpression);
    uncheckedTypeAssertions += asExpressions.length;

    // Count non-null assertions (`!`)
    const nonNullAssertions = sf.getDescendantsOfKind(SyntaxKind.NonNullExpression);
    uncheckedTypeAssertions += nonNullAssertions.length;

    // Count exports per module for API surface
    const exports = sf.getExportedDeclarations();
    const exportCount = exports.size;
    if (exportCount > 0) {
      apiSurface[modPath] = (apiSurface[modPath] ?? 0) + exportCount;
    }

    // Extract call graph edges (cap at 100 total)
    if (callEdges.length < 100) {
      const functions = [
        ...sf.getFunctions(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...sf.getClasses().flatMap((c: any) => c.getMethods()),
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const fn of functions as any[]) {
        const callerName = `${relPath}:${fn.getName?.() ?? '<anonymous>'}`;
        const calls = fn.getDescendantsOfKind(SyntaxKind.CallExpression);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const call of calls.slice(0, 10) as any[]) {
          const expr = call.getExpression();
          const calleeName = (expr.getText() as string).slice(0, 80);
          callEdges.push({ caller: callerName, callee: calleeName });
          if (callEdges.length >= 100) break;
        }
        if (callEdges.length >= 100) break;
      }
    }
  }

  // Build any propagation paths — group by file, find which files import `any`-containing files
  const anyPropagationPaths: TypeScriptAnalysis['any_propagation_paths'] = [];
  if (anyLocations.length > 0) {
    const anyFiles = new Set(anyLocations.map(l => l.file));
    // Simple 1-hop propagation: files that import from `any`-heavy files
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const sf of sourceFiles as any[]) {
      const relPath = path.relative(repoRoot, sf.getFilePath());
      if (anyFiles.has(relPath)) continue;
      const importDecls = sf.getImportDeclarations();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const imp of importDecls as any[]) {
        const moduleSpecifier: string = imp.getModuleSpecifierValue();
        // Check if this import resolves to an `any`-heavy file
        for (const anyFile of anyFiles) {
          if (moduleSpecifier.includes(path.basename(anyFile, path.extname(anyFile)))) {
            anyPropagationPaths.push({
              source: anyFile,
              reaches: [relPath],
              length: 1,
            });
            break;
          }
        }
        if (anyPropagationPaths.length >= 10) break;
      }
      if (anyPropagationPaths.length >= 10) break;
    }
  }

  return {
    any_count: anyCount,
    any_propagation_paths: anyPropagationPaths,
    call_graph_edges: callEdges,
    api_surface: apiSurface,
    unchecked_type_assertions: uncheckedTypeAssertions,
  };
}
