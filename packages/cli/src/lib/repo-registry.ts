/**
 * Global repo registry — tracks which repos are authorized for BlockSpool.
 * Stored at ~/.blockspool/allowed-repos.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RepoEntry {
  /** Git remote URL (e.g., git@github.com:user/repo.git) */
  remote: string;
  /** Local path where the repo was initialized */
  localPath: string;
  /** When the repo was authorized */
  authorizedAt: string;
  /** Human-friendly name (derived from remote) */
  name: string;
}

interface RepoRegistryFile {
  version: number;
  repos: RepoEntry[];
}

function getRegistryPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  const dir = path.join(home, '.blockspool');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'allowed-repos.json');
}

function loadRegistry(): RepoRegistryFile {
  const registryPath = getRegistryPath();
  if (!fs.existsSync(registryPath)) {
    return { version: 1, repos: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
  } catch {
    return { version: 1, repos: [] };
  }
}

function saveRegistry(registry: RepoRegistryFile): void {
  fs.writeFileSync(getRegistryPath(), JSON.stringify(registry, null, 2));
}

/**
 * Extract a human-friendly name from a git remote URL.
 */
export function repoNameFromRemote(remote: string): string {
  // git@github.com:user/repo.git → user/repo
  // https://github.com/user/repo.git → user/repo
  const match = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1] : remote;
}

/**
 * Check if a remote URL is already authorized.
 */
export function isRepoAuthorized(remote: string): boolean {
  const registry = loadRegistry();
  return registry.repos.some(r => r.remote === remote);
}

/**
 * Add a repo to the global authorized list.
 */
export function authorizeRepo(remote: string, localPath: string): void {
  const registry = loadRegistry();

  // Update existing entry or add new one
  const existing = registry.repos.findIndex(r => r.remote === remote);
  const entry: RepoEntry = {
    remote,
    localPath,
    authorizedAt: new Date().toISOString(),
    name: repoNameFromRemote(remote),
  };

  if (existing >= 0) {
    registry.repos[existing] = entry;
  } else {
    registry.repos.push(entry);
  }

  saveRegistry(registry);
}

/**
 * Remove a repo from the global authorized list.
 */
export function deauthorizeRepo(remote: string): boolean {
  const registry = loadRegistry();
  const before = registry.repos.length;
  registry.repos = registry.repos.filter(r => r.remote !== remote);
  if (registry.repos.length < before) {
    saveRegistry(registry);
    return true;
  }
  return false;
}

/**
 * List all authorized repos.
 */
export function listAuthorizedRepos(): RepoEntry[] {
  return loadRegistry().repos;
}
