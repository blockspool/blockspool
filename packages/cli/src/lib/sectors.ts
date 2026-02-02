/**
 * Sector-based scout scanning with staleness-based rotation.
 *
 * Flat list of scan records (one per codebase-index module). No splitting,
 * no parent/child hierarchy, no cross-ref bumps, no SHA-1 hashing.
 * Persists to `.blockspool/sectors.json`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Sector {
  path: string;            // module path from codebase-index ("src/lib")
  purpose: string;         // from codebase-index
  fileCount: number;
  lastScannedAt: number;   // epoch ms, 0 = never
  lastScannedCycle: number;
  scanCount: number;
  proposalYield: number;   // EMA of proposals per scan
}

export interface SectorState {
  version: 2;
  builtAt: string;
  sectors: Sector[];
}

export interface CodebaseModuleLike {
  path: string;
  file_count?: number;
  purpose?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_DIR = '.blockspool';
const STATE_FILE = 'sectors.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function norm(p: string): string {
  const s = p.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  return s || '.';
}

function defaultSectorsFile(repoRoot: string): string {
  return path.join(repoRoot, STATE_DIR, STATE_FILE);
}

function isLowPriority(sector: Sector): boolean {
  const purpose = (sector.purpose || '').toLowerCase();
  if (purpose === 'tests' || purpose === 'config') return true;
  // Also check path segments for test/config directories
  const parts = sector.path.toLowerCase().split('/');
  return parts.some(p =>
    p === 'test' || p === 'tests' || p === '__tests__' ||
    p === 'spec' || p === 'specs' || p === 'config' || p === 'configs'
  );
}

function ensureStateDir(repoRoot: string): void {
  const d = path.join(repoRoot, STATE_DIR);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ---------------------------------------------------------------------------
// Scope conversion
// ---------------------------------------------------------------------------

export function sectorToScope(sector: Sector): string {
  const p = norm(sector.path);
  if (p === '.') return './{*,.*}';
  return `${p}/**`;
}

// ---------------------------------------------------------------------------
// Build sectors from codebase-index modules
// ---------------------------------------------------------------------------

function buildSectors(modules: CodebaseModuleLike[]): Sector[] {
  const seen = new Set<string>();
  const sectors: Sector[] = [];

  for (const m of modules) {
    const p = norm(m.path);
    if (seen.has(p)) continue;
    seen.add(p);
    sectors.push({
      path: p,
      purpose: m.purpose ?? '',
      fileCount: m.file_count ?? 0,
      lastScannedAt: 0,
      lastScannedCycle: 0,
      scanCount: 0,
      proposalYield: 0,
    });
  }

  // Root sector only if no modules cover it (and don't add with fileCount 0 — it'd be dead)
  // Callers that need a root fallback use the '**' broad scan in solo-auto.

  return sectors;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function saveSectors(repoRoot: string, state: SectorState): void {
  ensureStateDir(repoRoot);
  fs.writeFileSync(defaultSectorsFile(repoRoot), JSON.stringify(state, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadOrBuildSectors(
  repoRoot: string,
  modules: CodebaseModuleLike[],
): SectorState {
  const sectorsFile = defaultSectorsFile(repoRoot);

  if (fs.existsSync(sectorsFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(sectorsFile, 'utf8'));
      if (parsed?.version === 2 && Array.isArray(parsed.sectors)) {
        // Normalize fields
        for (const s of parsed.sectors) {
          s.path = norm(s.path ?? '.');
          s.purpose ??= '';
          s.fileCount ??= 0;
          s.lastScannedAt ??= 0;
          s.lastScannedCycle ??= 0;
          s.scanCount ??= 0;
          s.proposalYield ??= 0;
        }
        return parsed as SectorState;
      }
    } catch {
      // fallthrough to rebuild
    }
  }

  // Build fresh (v1 files are discarded — not worth migrating)
  const state: SectorState = {
    version: 2,
    builtAt: new Date().toISOString(),
    sectors: buildSectors(modules),
  };
  saveSectors(repoRoot, state);
  return state;
}

export function refreshSectors(
  repoRoot: string,
  previous: SectorState,
  modules: CodebaseModuleLike[],
): SectorState {
  const fresh = buildSectors(modules);
  const prevByPath = new Map(previous.sectors.map(s => [s.path, s]));

  const merged = fresh.map(s => {
    const prev = prevByPath.get(s.path);
    if (!prev) return s;
    return {
      ...s,
      lastScannedAt: prev.lastScannedAt,
      lastScannedCycle: prev.lastScannedCycle,
      scanCount: prev.scanCount,
      proposalYield: prev.proposalYield,
    };
  });

  const state: SectorState = {
    version: 2,
    builtAt: new Date().toISOString(),
    sectors: merged,
  };
  saveSectors(repoRoot, state);
  return state;
}

export function pickNextSector(state: SectorState, currentCycle: number): { sector: Sector; scope: string } | null {
  if (state.sectors.length === 0) return null;

  const primary = state.sectors.filter(s => s.fileCount > 0 && !isLowPriority(s));
  const candidates =
    primary.some(s => s.lastScannedAt === 0) ? primary
    : primary.some(s => currentCycle - s.lastScannedCycle >= 2) ? primary
    : state.sectors.filter(s => s.fileCount > 0); // include tests/config

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if ((a.lastScannedAt === 0) !== (b.lastScannedAt === 0)) return a.lastScannedAt === 0 ? -1 : 1;
    if (a.lastScannedCycle !== b.lastScannedCycle) return a.lastScannedCycle - b.lastScannedCycle;
    return a.path.localeCompare(b.path);
  });

  const sector = candidates[0];
  return { sector, scope: sectorToScope(sector) };
}

export function recordScanResult(
  state: SectorState,
  sectorPath: string,
  currentCycle: number,
  proposalCount: number,
): void {
  const s = state.sectors.find(x => x.path === sectorPath);
  if (!s) return;

  s.lastScannedAt = Date.now();
  s.lastScannedCycle = currentCycle;
  s.scanCount = (s.scanCount ?? 0) + 1;
  s.proposalYield = 0.7 * (s.proposalYield ?? 0) + 0.3 * proposalCount;
}
