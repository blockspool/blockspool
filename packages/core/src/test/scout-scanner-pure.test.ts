import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { batchFiles, scanFiles } from '../scout/scanner.js';
import type { ScannedFile } from '../scout/scanner.js';

function makeFile(p: string, content = 'x', size = 1): ScannedFile {
  return { path: p, content, size };
}

describe('batchFiles', () => {
  it('with empty array returns empty array', () => {
    expect(batchFiles([])).toEqual([]);
  });

  it('with fewer files than batch size returns single batch', () => {
    const files = [makeFile('a.ts'), makeFile('b.ts')];
    const batches = batchFiles(files);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it('with exact multiple returns correct number of batches', () => {
    const files = [makeFile('a'), makeFile('b'), makeFile('c'), makeFile('d'), makeFile('e'), makeFile('f')];
    const batches = batchFiles(files, 3);
    expect(batches).toHaveLength(2);
  });

  it('with remainder creates extra batch', () => {
    const files = [makeFile('a'), makeFile('b'), makeFile('c'), makeFile('d')];
    const batches = batchFiles(files, 3);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toHaveLength(1);
  });

  it('default batch size is 3', () => {
    const files = Array.from({ length: 7 }, (_, i) => makeFile(`f${i}`));
    const batches = batchFiles(files);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(3);
    expect(batches[1]).toHaveLength(3);
    expect(batches[2]).toHaveLength(1);
  });

  it('with custom batch size', () => {
    const files = Array.from({ length: 5 }, (_, i) => makeFile(`f${i}`));
    const batches = batchFiles(files, 2);
    expect(batches).toHaveLength(3);
  });

  it('preserves file order', () => {
    const files = [makeFile('a'), makeFile('b'), makeFile('c'), makeFile('d')];
    const batches = batchFiles(files, 2);
    expect(batches[0][0].path).toBe('a');
    expect(batches[0][1].path).toBe('b');
    expect(batches[1][0].path).toBe('c');
    expect(batches[1][1].path).toBe('d');
  });

  it('each batch has correct files', () => {
    const files = [makeFile('x'), makeFile('y'), makeFile('z')];
    const batches = batchFiles(files, 2);
    expect(batches[0]).toEqual([files[0], files[1]]);
    expect(batches[1]).toEqual([files[2]]);
  });

  it('with batch size 1 creates one batch per file', () => {
    const files = [makeFile('a'), makeFile('b'), makeFile('c')];
    const batches = batchFiles(files, 1);
    expect(batches).toHaveLength(3);
    batches.forEach((b) => expect(b).toHaveLength(1));
  });

  it('with batch size larger than array returns single batch', () => {
    const files = [makeFile('a'), makeFile('b')];
    const batches = batchFiles(files, 100);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });
});

describe('scanFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relPath: string, content: string) {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  it('finds .ts files with include pattern', () => {
    writeFile('src/a.ts', 'export const a = 1;');
    writeFile('src/b.ts', 'export const b = 2;');
    writeFile('src/c.js', 'module.exports = {}');
    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'] });
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.path.endsWith('.ts'))).toBe(true);
  });

  it('excludes node_modules by default', () => {
    writeFile('src/a.ts', 'ok');
    writeFile('node_modules/pkg/index.ts', 'skip');
    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'] });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/a.ts');
  });

  it('respects maxFiles limit', () => {
    for (let i = 0; i < 10; i++) {
      writeFile(`src/f${i}.ts`, `const x = ${i};`);
    }
    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'], maxFiles: 3 });
    expect(files).toHaveLength(3);
  });

  it('respects maxFileSize limit', () => {
    writeFile('small.ts', 'ok');
    writeFile('big.ts', 'x'.repeat(500));
    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'], maxFileSize: 100 });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('small.ts');
  });

  it('returns empty for non-existent directory', () => {
    const files = scanFiles({ cwd: path.join(tmpDir, 'nope'), include: ['**/*.ts'] });
    expect(files).toEqual([]);
  });

  it('with exclude patterns skips matching files', () => {
    writeFile('src/a.ts', 'ok');
    writeFile('src/b.generated.ts', 'skip');
    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'], exclude: ['*.generated.ts'] });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/a.ts');
  });

  it('returns content and size for each file', () => {
    writeFile('src/hello.ts', 'hello world');
    const files = scanFiles({ cwd: tmpDir, include: ['**/*.ts'] });
    expect(files).toHaveLength(1);
    expect(files[0].content).toBe('hello world');
    expect(files[0].size).toBe(11);
  });
});
