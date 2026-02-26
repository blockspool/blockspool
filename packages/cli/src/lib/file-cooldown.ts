/**
 * File cooldown tracking for pending PRs.
 * Prevents scheduling overlapping work on files that already have open PRs.
 */

import * as path from 'node:path';
import { readJsonState, writeJsonState } from './goals.js';

interface CooldownEntry {
  filePath: string;
  prUrl: string;
  createdAt: number;
}

const COOLDOWN_FILE = 'file-cooldown.json';
const TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

function cooldownPath(repoRoot: string): string {
  return path.join(repoRoot, '.promptwheel', COOLDOWN_FILE);
}

function isCooldownEntryArray(value: unknown): value is CooldownEntry[] {
  return Array.isArray(value);
}

function readEntries(repoRoot: string): CooldownEntry[] {
  return readJsonState(cooldownPath(repoRoot), {
    fallback: [],
    validate: isCooldownEntryArray,
  });
}

function writeEntries(repoRoot: string, entries: CooldownEntry[]): void {
  writeJsonState(cooldownPath(repoRoot), entries, { trailingNewline: true });
}

function prune(entries: CooldownEntry[]): CooldownEntry[] {
  const cutoff = Date.now() - TTL_MS;
  return entries.filter(e => e.createdAt > cutoff);
}

export function recordPrFiles(repoRoot: string, prUrl: string, files: string[]): void {
  const entries = prune(readEntries(repoRoot));
  const now = Date.now();
  for (const filePath of files) {
    entries.push({ filePath, prUrl, createdAt: now });
  }
  writeEntries(repoRoot, entries);
}

export function getCooledFiles(repoRoot: string): Map<string, string> {
  const raw = readEntries(repoRoot);
  const entries = prune(raw);
  // Only write back if entries were actually pruned
  if (entries.length < raw.length) {
    writeEntries(repoRoot, entries);
  }
  const map = new Map<string, string>();
  for (const e of entries) {
    map.set(e.filePath, e.prUrl);
  }
  return map;
}

export function removePrEntries(repoRoot: string, prUrls: string[]): void {
  if (prUrls.length === 0) return;
  const urlSet = new Set(prUrls);
  const entries = readEntries(repoRoot).filter(e => !urlSet.has(e.prUrl));
  writeEntries(repoRoot, prune(entries));
}

export function computeCooldownOverlap(files: string[], cooledFiles: Map<string, string>): number {
  if (files.length === 0 || cooledFiles.size === 0) return 0;
  let overlap = 0;
  for (const f of files) {
    if (cooledFiles.has(f)) overlap++;
  }
  return overlap / files.length;
}
