/**
 * Tests for MISSION.md loading — packages/mcp/src/guidelines.ts loadMission()
 * and formatMissionForPrompt from core.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadMission, formatMissionForPrompt } from '../guidelines.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-mission-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadMission', () => {
  it('returns null when .promptwheel/MISSION.md does not exist', () => {
    expect(loadMission(tmpDir)).toBeNull();
  });

  it('returns null when .promptwheel dir exists but no MISSION.md', () => {
    fs.mkdirSync(path.join(tmpDir, '.promptwheel'), { recursive: true });
    expect(loadMission(tmpDir)).toBeNull();
  });

  it('returns content when MISSION.md exists', () => {
    const missionDir = path.join(tmpDir, '.promptwheel');
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, 'MISSION.md'), 'Focus on security and reliability.');
    expect(loadMission(tmpDir)).toBe('Focus on security and reliability.');
  });

  it('trims whitespace from content', () => {
    const missionDir = path.join(tmpDir, '.promptwheel');
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, 'MISSION.md'), '  trim me  \n\n');
    expect(loadMission(tmpDir)).toBe('trim me');
  });

  it('returns null for empty MISSION.md', () => {
    const missionDir = path.join(tmpDir, '.promptwheel');
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, 'MISSION.md'), '   \n\n  ');
    expect(loadMission(tmpDir)).toBeNull();
  });
});

describe('formatMissionForPrompt', () => {
  it('wraps content in mission tags', () => {
    const result = formatMissionForPrompt('Be helpful and safe.');
    expect(result).toBe('<mission>\nBe helpful and safe.\n</mission>');
  });

  it('preserves multiline content', () => {
    const content = '# My Mission\n\nBuild great stuff.\n- Quality first\n- Ship fast';
    const result = formatMissionForPrompt(content);
    expect(result).toContain('# My Mission');
    expect(result).toContain('- Quality first');
    expect(result.startsWith('<mission>')).toBe(true);
    expect(result.endsWith('</mission>')).toBe(true);
  });
});
