/**
 * TUI Auto Screen — unified log with ticket bookmarks.
 *
 * Layout:
 * ┌─ Header ──────────────────────────────────────────────────────┐
 * │ PromptWheel v0.5.63 │ direct │ 12m │ Cycle 2 │ 3 done         │
 * ├───────────────────────────────────────────────────────────────┤
 * │ > Fix auth  ✓ Add tests  ✗ Refactor  ○ Update docs           │
 * ├───────────────────────────────────────────────────────────────┤
 * │ [scout] Scouting packages/core/**...                          │
 * │ [scout] Complete: 3 proposals                                 │
 * │                                                               │
 * │ ═══ [1] Fix auth validation ═══                               │
 * │ Reading src/auth/login.ts...                                  │
 * │ Found validateToken function on line 42.                      │
 * │ Writing src/auth/login.ts...                                  │
 * │ --- DONE: Committed to direct branch ---                      │
 * │                                                               │
 * │ ═══ [2] Add tests ═══                                         │
 * │ Reading src/auth/login.test.ts...                             │
 * │                                                               │
 * ├───────────────────────────────────────────────────────────────┤
 * │ >                                                             │
 * └───────────────────────────────────────────────────────────────┘
 */

import blessed from 'neo-blessed';
import type { Widgets } from 'neo-blessed';
import { createWriteStream, mkdirSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { join } from 'node:path';
import { TicketOutputBuffer } from '../ticket-output-buffer.js';
import { formatProgressLine, renderProgressBar, type ProgressSnapshot, type SectorMapData } from '../../lib/display-adapter.js';

export type TicketStatus = 'running' | 'done' | 'failed' | 'pending';

interface TicketEntry {
  id: string;
  title: string;
  slotLabel: string;
  status: TicketStatus;
  bookmarkLine: number; // line in unified log where this ticket starts
}

export interface AutoScreenOptions {
  version: string;
  deliveryMode: string;
  repoRoot?: string;
  onInput?: (text: string) => void;
  onQuit?: () => void;
}

const STATUS_ICONS: Record<TicketStatus, string> = {
  running: '{yellow-fg}>{/yellow-fg}',
  done: '{green-fg}✓{/green-fg}',
  failed: '{red-fg}✗{/red-fg}',
  pending: '{gray-fg}○{/gray-fg}',
};

export class AutoScreen {
  private screen: Widgets.Screen;
  private header: Widgets.BoxElement;
  private ticketBar: Widgets.BoxElement;
  private mainPane: Widgets.BoxElement;
  private inputBar: Widgets.BoxElement;

  private tickets: TicketEntry[] = [];
  private selectedIndex = -1;
  private following = true;
  private unifiedLog: TicketOutputBuffer;
  private batchProgressStart = -1; // line where batch progress block starts
  private lastStatusLine = -1;     // line of last status update (for in-place replace)
  private lastRawChunk = '';        // dedup consecutive identical raw output

  // Session info for header
  private cycleCount = 0;
  private doneCount = 0;
  private failedCount = 0;
  private startTime = Date.now();
  private endTime: number | undefined;

  private drillInfo: { active: boolean; trajectoryName?: string; trajectoryProgress?: string; ambitionLevel?: string } | null = null;
  private lastProgress: ProgressSnapshot | null = null;

  private sectorOverlay: Widgets.BoxElement;
  private splitMapPane: Widgets.BoxElement;
  private viewMode: 'log' | 'split' | 'map' = 'log';
  private lastSectorData: SectorMapData | null = null;

  private headerTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private shuttingDown = false;
  private logStream: WriteStream | null = null;

  constructor(private opts: AutoScreenOptions) {
    this.unifiedLog = new TicketOutputBuffer(50_000);

    this.screen = blessed.screen({
      smartCSR: true,
      title: `PromptWheel v${opts.version}`,
      fullUnicode: true,
      tags: true,
    });

    // Log file for reviewing output outside TUI
    if (opts.repoRoot) {
      try {
        const logDir = join(opts.repoRoot, '.promptwheel');
        mkdirSync(logDir, { recursive: true });
        this.logStream = createWriteStream(join(logDir, 'tui.log'), { flags: 'w' });
        this.writeLog(`PromptWheel v${opts.version} — TUI session started at ${new Date().toISOString()}\n`);
      } catch {
        // Non-fatal
      }
    }

    // Header bar (row 0)
    this.header = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: true,
      style: { fg: 'white', bg: 'blue', bold: true },
    });

    // Ticket bar (rows 1-2, bordered)
    this.ticketBar = blessed.box({
      parent: this.screen,
      top: 1,
      left: 0,
      width: '100%',
      height: 3,
      border: { type: 'line' },
      tags: true,
      style: {
        border: { fg: 'gray' },
        fg: 'white',
      },
    });

    // Main output pane (full width, tags disabled for raw output)
    this.mainPane = blessed.box({
      parent: this.screen,
      top: 4,
      left: 0,
      width: '100%',
      height: '100%-7', // header(1) + ticketBar(3) + inputBar(3)
      border: { type: 'line' },
      tags: false,
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      scrollbar: {
        ch: '│',
        style: { bg: 'blue' },
      },
      style: {
        border: { fg: 'gray' },
      },
    });

    // Input bar at bottom
    this.inputBar = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 3,
      border: { type: 'line' },
      tags: true,
      style: {
        border: { fg: 'cyan' },
        fg: 'white',
      },
      content: ' {cyan-fg}>{/cyan-fg}',
    });

    // Sector map overlay (full-screen map view, hidden by default)
    this.sectorOverlay = blessed.box({
      parent: this.screen,
      top: 4,
      left: 0,
      width: '100%',
      height: '100%-7',
      border: { type: 'line' },
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      hidden: true,
      label: ' Sector Map (Tab to rotate) ',
      style: {
        border: { fg: 'cyan' },
        fg: 'white',
      },
    });

    // Split-view map pane (bottom portion in split mode, hidden by default)
    this.splitMapPane = blessed.box({
      parent: this.screen,
      top: 4,
      left: 0,
      width: '100%',
      height: '100%-7',
      border: { type: 'line' },
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      hidden: true,
      label: ' Sector Map ',
      style: {
        border: { fg: 'cyan' },
        fg: 'white',
      },
    });

    this.setupKeys();
    this.updateHeader();
    this.updateTicketBar();
    this.updateHint();

    // Refresh header + progress bar every second
    this.headerTimer = setInterval(() => {
      if (this.destroyed) return;
      this.updateHeader();
      this.refreshProgressBar();
    }, 1000);

    // Handle resize
    this.screen.on('resize', () => {
      this.updateTicketBar();
      this.layoutViews();
    });

    this.screen.render();
  }

  private setupKeys(): void {
    // Tab: cycle view mode (log → split → map → log)
    this.screen.key('tab', () => {
      this.cycleView();
    });

    // [/]: navigate tickets (replaces Tab's old ticket-cycling role)
    this.screen.key('[', () => {
      if (this.tickets.length === 0) return;
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.jumpToTicket(this.selectedIndex);
    });
    this.screen.key(']', () => {
      if (this.tickets.length === 0) return;
      this.selectedIndex = Math.min(this.selectedIndex + 1, this.tickets.length - 1);
      this.jumpToTicket(this.selectedIndex);
    });

    // j/k: navigate tickets
    this.screen.key('j', () => {
      if (this.tickets.length === 0) return;
      this.selectedIndex = Math.min(this.selectedIndex + 1, this.tickets.length - 1);
      this.jumpToTicket(this.selectedIndex);
    });
    this.screen.key('k', () => {
      if (this.tickets.length === 0) return;
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.jumpToTicket(this.selectedIndex);
    });

    // Scroll output pane
    this.screen.key(['up'], () => {
      this.following = false;
      this.mainPane.scroll(-1);
      this.screen.render();
    });
    this.screen.key(['down'], () => {
      this.mainPane.scroll(1);
      this.screen.render();
    });
    this.screen.key(['pageup', 'S-up'], () => {
      this.following = false;
      this.mainPane.scroll(-10);
      this.screen.render();
    });
    this.screen.key(['pagedown', 'S-down'], () => {
      this.mainPane.scroll(10);
      this.screen.render();
    });

    // G or End: resume auto-scroll
    this.screen.key(['G', 'end'], () => {
      this.following = true;
      this.mainPane.setScrollPerc(100);
      this.screen.render();
    });

    // Ctrl+C: first graceful, second force-quit
    let ctrlCCount = 0;
    this.screen.key(['C-c'], () => {
      ctrlCCount++;
      if (ctrlCCount >= 2) {
        this.destroy();
        process.exit(1);
      }
      this.shuttingDown = true;
      this.inputBar.setContent(' {red-fg}Shutdown requested. Press Ctrl+C again to force quit.{/red-fg}');
      this.screen.render();
      this.opts.onQuit?.();
    });
  }

  private updateHeader(): void {
    if (this.destroyed) return;
    const elapsed = this.formatElapsed(Date.now() - this.startTime);
    const timeLeft = this.endTime
      ? ` │ ${this.formatElapsed(Math.max(0, this.endTime - Date.now()))} left`
      : '';
    const cycle = this.cycleCount > 0 ? ` │ Cycle ${this.cycleCount}` : '';
    const counts = ` │ ${this.doneCount} done${this.failedCount > 0 ? ` · ${this.failedCount} failed` : ''}`;

    let drill = '';
    if (this.drillInfo) {
      const ambTag = this.drillInfo.ambitionLevel && this.drillInfo.ambitionLevel !== 'moderate'
        ? ` [${this.drillInfo.ambitionLevel}]` : '';
      if (this.drillInfo.active && this.drillInfo.trajectoryName) {
        const progress = this.drillInfo.trajectoryProgress ? ` ${this.drillInfo.trajectoryProgress}` : '';
        drill = ` │ Drill: "${this.drillInfo.trajectoryName}"${progress}${ambTag}`;
      } else if (this.drillInfo.active) {
        drill = ` │ Drill: idle${ambTag}`;
      }
    }

    const content = ` {bold}PromptWheel v${this.opts.version}{/bold} │ ${this.opts.deliveryMode} │ ${elapsed}${timeLeft}${cycle}${counts}${drill}`;
    this.header.setContent(content);
    this.screen.render();
  }

  private updateTicketBar(): void {
    if (this.tickets.length === 0) {
      this.ticketBar.setContent(' {gray-fg}Waiting for scout...{/gray-fg}');
      return;
    }

    const screenWidth = (this.screen.width as number) - 4; // borders + padding
    const parts: string[] = [];

    for (let i = 0; i < this.tickets.length; i++) {
      const t = this.tickets[i];
      const icon = STATUS_ICONS[t.status];
      const selected = i === this.selectedIndex;
      const maxTitleLen = Math.floor(screenWidth / Math.min(this.tickets.length, 5)) - 6;
      const title = t.title.length > maxTitleLen
        ? t.title.slice(0, maxTitleLen - 2) + '..'
        : t.title;

      if (selected) {
        parts.push(`${icon} {bold}{underline}${title}{/underline}{/bold}`);
      } else {
        parts.push(`${icon} ${title}`);
      }
    }

    this.ticketBar.setContent(' ' + parts.join(' {gray-fg}│{/gray-fg} '));
  }

  private formatElapsed(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min < 60) return `${min}m${sec > 0 ? `${sec}s` : ''}`;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return `${hr}h${remMin}m`;
  }

  private appendToUnifiedLog(text: string): void {
    this.unifiedLog.append(text);
    this.mainPane.setContent(this.unifiedLog.getContent());
    if (this.following) this.mainPane.setScrollPerc(100);
    this.screen.render();
  }

  private jumpToTicket(index: number): void {
    if (index < 0 || index >= this.tickets.length) return;
    this.selectedIndex = index;
    this.following = false;
    const ticket = this.tickets[index];

    // Scroll to the bookmark line
    const targetLine = ticket.bookmarkLine;
    this.mainPane.setContent(this.unifiedLog.getContent());
    this.mainPane.scrollTo(targetLine);

    this.updateTicketBar();
    this.screen.render();
  }

  // Public API

  setDrillInfo(info: { active: boolean; trajectoryName?: string; trajectoryProgress?: string; ambitionLevel?: string } | null): void {
    this.drillInfo = info;
    this.updateHeader();
  }

  setProgress(snapshot: ProgressSnapshot): void {
    this.lastProgress = snapshot;
    this.refreshProgressBar();
  }

  private refreshProgressBar(): void {
    if (!this.lastProgress || this.destroyed || this.shuttingDown) return;
    // Update elapsed time in real-time from stored snapshot's start reference
    const liveSnapshot: ProgressSnapshot = {
      ...this.lastProgress,
      elapsedMs: Date.now() - (this.startTime || Date.now()),
    };
    const line = formatProgressLine(liveSnapshot);
    const viewLabel = this.viewMode === 'log' ? 'Log' : this.viewMode === 'split' ? 'Split' : 'Map';
    this.inputBar.setContent(` ${line} {gray-fg}[${viewLabel}]{/gray-fg}`);
    this.screen.render();
  }

  setSessionInfo(info: { startTime: number; endTime?: number; cycleCount: number }): void {
    this.startTime = info.startTime;
    this.endTime = info.endTime;
    this.cycleCount = info.cycleCount;
    this.updateHeader();
  }

  addTicket(id: string, title: string, slotLabel: string): void {
    this.lastStatusLine = -1;
    this.lastRawChunk = '';
    this.writeLog(`\n=== TICKET [${id}] ${title} (${slotLabel}) ===\n`);
    const bookmarkLine = this.unifiedLog.lineCount;
    this.appendToUnifiedLog(`\n═══ [${slotLabel}] ${title} ═══\n`);
    const entry: TicketEntry = {
      id,
      title,
      slotLabel,
      status: 'running',
      bookmarkLine,
    };
    this.tickets.push(entry);
    this.selectedIndex = this.tickets.length - 1;
    this.updateTicketBar();
    this.screen.render();
  }

  updateTicketStatus(id: string, msg: string): void {
    const entry = this.tickets.find(t => t.id === id);
    if (!entry) return;
    // Replace previous status line in-place (avoids "Running... (4m9s)" spam)
    if (this.lastStatusLine >= 0) {
      this.unifiedLog.truncateTo(this.lastStatusLine);
    }
    this.lastStatusLine = this.unifiedLog.lineCount;
    this.appendToUnifiedLog(`[${entry.slotLabel}] ${msg}\n`);
  }

  appendOutput(id: string, chunk: string): void {
    const entry = this.tickets.find(t => t.id === id);
    if (!entry) return;
    // Dedup consecutive identical chunks (codex emits same thinking block multiple times)
    if (chunk === this.lastRawChunk && chunk.length > 20) return;
    this.lastRawChunk = chunk;
    this.writeLog(chunk);
    // Filter JSONL telemetry, noisy subprocess stderr, and strip ANSI
    const output = this.filterRawOutput(chunk);
    if (output) {
      this.lastStatusLine = -1; // real output arrived, stop replacing status line
      this.appendToUnifiedLog(output);
    }
  }

  markTicketDone(id: string, success: boolean, msg: string): void {
    const entry = this.tickets.find(t => t.id === id);
    if (!entry) return;
    this.lastStatusLine = -1;
    this.lastRawChunk = '';
    entry.status = success ? 'done' : 'failed';
    const marker = success ? 'DONE' : 'FAILED';
    this.writeLog(`\n--- ${marker} [${id}]: ${msg} ---\n`);
    this.appendToUnifiedLog(`\n--- ${marker} [${entry.slotLabel}]: ${msg} ---\n`);

    if (success) this.doneCount++;
    else this.failedCount++;

    this.updateTicketBar();
    this.updateHeader();
    this.screen.render();
  }

  showScoutProgress(msg: string): void {
    this.writeLog(`[scout] ${msg}\n`);
    if (msg.toLowerCase().includes('complete')) {
      this.resetBatchProgress();
    }
    this.appendToUnifiedLog(`[scout] ${msg}\n`);
  }

  appendScoutOutput(chunk: string): void {
    this.writeLog(chunk);
    const output = this.filterRawOutput(chunk);
    if (output) this.appendToUnifiedLog(output);
  }

  /** Filter JSONL telemetry, ANSI codes, and noisy subprocess stderr from raw CLI output. */
  private filterRawOutput(chunk: string): string {
    const lines = chunk.split('\n');
    const filtered: string[] = [];
    for (const line of lines) {
      // eslint-disable-next-line no-control-regex
      const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
      const trimmed = clean.trim();
      // Skip JSONL telemetry (lines that parse as JSON objects)
      if (trimmed.startsWith('{')) {
        try { JSON.parse(trimmed); continue; } catch { /* not JSON, keep it */ }
      }
      // Skip noisy subprocess stderr
      if (trimmed.includes('codex_core::') || trimmed.includes('state db missing rollout path')) {
        continue;
      }
      // Skip Codex phase output (emitted by codex.ts backend as formatted lines)
      if (/^\[(?:Thinking|Running|Starting command|Reading|Writing|Searching|Tool|Completing)\]/.test(trimmed)) continue;
      // Skip slot-prefixed variants: [1] Thinking: ..., [2] Running...
      if (/^\[\d+\]\s+(?:Thinking|Running|Starting command|Reading|Writing|Starting)/.test(trimmed)) continue;
      // Skip bare phase lines without brackets
      if (/^(?:Thinking|Running)[:.]/.test(trimmed)) continue;
      if (trimmed || line === '') {
        filtered.push(clean);
      }
    }
    const output = filtered.join('\n');
    return output.trim() ? output : '';
  }

  showScoutBatchProgress(statuses: Array<{ index: number; status: string; proposals?: number }>, totalBatches: number, totalProposals: number): void {
    const lines: string[] = [];
    lines.push(`Scouting ${totalBatches} batches (${totalProposals} proposals found)`);
    for (let i = 0; i < totalBatches; i++) {
      const s = statuses.find(b => b.index === i);
      if (!s || s.status === 'waiting') {
        lines.push(`  ○ Batch ${i + 1}  waiting`);
      } else if (s.status === 'running') {
        lines.push(`  > Batch ${i + 1}  analyzing...`);
      } else if (s.status === 'done') {
        const pStr = s.proposals ? `${s.proposals} proposal${s.proposals !== 1 ? 's' : ''}` : 'no proposals';
        lines.push(`  ✓ Batch ${i + 1}  ${pStr}`);
      } else if (s.status === 'failed') {
        lines.push(`  ✗ Batch ${i + 1}  failed`);
      }
    }
    this.writeLog(`[scout] ${lines.join(' | ')}\n`);

    // Replace previous batch block in-place instead of appending
    if (this.batchProgressStart >= 0) {
      this.unifiedLog.truncateTo(this.batchProgressStart);
    } else {
      this.batchProgressStart = this.unifiedLog.lineCount;
    }
    this.appendToUnifiedLog(lines.join('\n') + '\n');
  }

  /** Reset batch progress tracker (call when scout finishes) */
  private resetBatchProgress(): void {
    this.batchProgressStart = -1;
  }

  showLog(msg: string): void {
    this.writeLog(`[log] ${msg}\n`);
    // Strip ANSI escape codes — mainPane has tags:false so they render as literal text
    // eslint-disable-next-line no-control-regex
    const clean = msg.replace(/\x1b\[[0-9;]*m/g, '');
    this.appendToUnifiedLog(clean + '\n');
  }

  private writeLog(msg: string): void {
    // eslint-disable-next-line no-control-regex
    this.logStream?.write(msg.replace(/\x1b\[[0-9;]*m/g, ''));
  }

  updateSectorMap(data: SectorMapData): void {
    this.lastSectorData = data;
    if (this.viewMode === 'map') {
      this.renderSectorOverlay();
      this.screen.render();
    } else if (this.viewMode === 'split') {
      this.renderSplitMapContent();
      this.screen.render();
    }
  }

  private cycleView(): void {
    const modes: Array<'log' | 'split' | 'map'> = ['log', 'split', 'map'];
    const i = modes.indexOf(this.viewMode);
    this.viewMode = modes[(i + 1) % modes.length];
    this.layoutViews();
    this.updateHint();
  }

  private layoutViews(): void {
    const available = (this.screen.height as number) - 7; // header(1) + ticketBar(3) + inputBar(3)
    const top = 4; // below header + ticketBar

    switch (this.viewMode) {
      case 'log':
        this.mainPane.top = top;
        this.mainPane.height = available;
        this.mainPane.show();
        this.splitMapPane.hide();
        this.sectorOverlay.hide();
        this.mainPane.focus();
        break;

      case 'split': {
        const logH = Math.ceil(available * 0.6);
        const mapH = available - logH;
        this.mainPane.top = top;
        this.mainPane.height = logH;
        this.mainPane.show();
        this.splitMapPane.top = top + logH;
        this.splitMapPane.height = mapH;
        this.renderSplitMapContent();
        this.splitMapPane.show();
        this.sectorOverlay.hide();
        this.mainPane.focus();
        break;
      }

      case 'map':
        this.mainPane.hide();
        this.splitMapPane.hide();
        this.sectorOverlay.top = top;
        this.sectorOverlay.height = available;
        this.renderSectorOverlay();
        this.sectorOverlay.show();
        this.sectorOverlay.focus();
        this.sectorOverlay.setFront();
        break;
    }

    this.screen.render();
  }

  private updateHint(): void {
    if (this.lastProgress || this.shuttingDown) return; // progress bar / shutdown message takes priority
    const viewLabel = this.viewMode === 'log' ? 'Log' : this.viewMode === 'split' ? 'Split' : 'Map';
    this.inputBar.setContent(` {gray-fg}Tab: rotate view (${viewLabel}) │ [/]: tickets │ j/k: nav │ G: follow{/gray-fg}`);
    this.screen.render();
  }

  private buildSectorMapContent(): string[] {
    const data = this.lastSectorData;
    if (!data) {
      return [' {gray-fg}No sector data yet — waiting for first scout cycle...{/gray-fg}'];
    }

    const lines: string[] = [];
    const cov = data.coverage;
    const tot = data.totals;
    const lens = data.lens;

    // ── Summary header ──────────────────────────────────────────────
    const polished = data.sectors.filter(s => s.status === 'polished').length;
    const hitRate = tot.totalTickets > 0 ? Math.round((tot.totalSuccesses / tot.totalTickets) * 100) : 0;

    lines.push(` {bold}Survey:{/bold} ${cov.scannedSectors}/${cov.totalSectors} sectors surveyed │ ${cov.scannedFiles}/${cov.totalFiles} files │ ${polished} exhausted`);
    lines.push(` {bold}Yield:{/bold}  ${tot.totalScans} scans │ ${tot.totalTickets} tickets │ ${hitRate}% hit rate │ avg ${tot.avgYield.toFixed(1)}/scan`);

    // Momentum: filled dots based on average yield across scanned sectors
    const dots = 5;
    const filled = Math.min(dots, Math.round(tot.avgYield * (dots / 3))); // 3.0 yield = full
    const momentum = '{yellow-fg}' + '●'.repeat(filled) + '{/yellow-fg}' + '{gray-fg}' + '○'.repeat(dots - filled) + '{/gray-fg}';
    const momentumLabel = filled === 0 ? 'stalled' : filled <= 2 ? 'prospecting' : filled <= 4 ? 'productive' : 'rich vein';
    lines.push(` {bold}Momentum:{/bold} ${momentum} ${momentumLabel}`);

    // Lens
    const lensPct = Math.round(lens.matrixCoverage * 100);
    const lensBar = renderProgressBar(lensPct, 12);
    lines.push(` {bold}Lens:{/bold} ${lens.current} (${lens.index + 1}/${lens.total}) ${lensBar} ${lensPct}%`);

    // Drill
    if (data.drill?.active) {
      const name = data.drill.trajectoryName ? `"${data.drill.trajectoryName}"` : 'idle';
      const step = data.drill.stepProgress ? ` step ${data.drill.stepProgress}` : '';
      const target = data.drill.targetSector ? ` → ${data.drill.targetSector}` : '';
      lines.push(` {bold}Drill:{/bold} ${name}${step}${target}`);
    }

    lines.push('');

    // ── Sector table ────────────────────────────────────────────────
    const screenWidth = (this.screen.width as number) || 80;
    const fixedCols = 4 + 6 + 6 + 6 + 8; // St + Files + Scans + Yield + Success + spacing
    const pathW = Math.min(50, Math.max(20, screenWidth - fixedCols - 6));
    const hdr = ` ${'St'} ${'Path'.padEnd(pathW)} ${'Files'.padStart(5)} ${'Scans'.padStart(5)} ${'Yield'.padStart(5)} ${'Success'.padStart(7)}`;
    lines.push(`{bold}${hdr}{/bold}`);
    lines.push(' ' + '─'.repeat(hdr.length - 1));

    // Sort: current first → scanning → scanned → pending → exhausted
    const statusOrder: Record<string, number> = { scanning: 0, scanned: 1, pending: 2, polished: 3 };
    const sorted = [...data.sectors].sort((a, b) => {
      if (a.isCurrent && !b.isCurrent) return -1;
      if (!a.isCurrent && b.isCurrent) return 1;
      return (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
    });

    for (const row of sorted) {
      let icon: string;
      switch (row.status) {
        case 'scanning': icon = '{yellow-fg}▶{/yellow-fg}'; break;
        case 'scanned':  icon = '{blue-fg}■{/blue-fg}'; break;
        case 'polished': icon = '{green-fg}✓{/green-fg}'; break;
        default:         icon = '{gray-fg}○{/gray-fg}'; break;
      }

      const p = row.path.length > pathW ? row.path.slice(0, pathW - 2) + '..' : row.path.padEnd(pathW);
      const yieldStr = row.yield.toFixed(1).padStart(5);
      const successStr = (Math.round(row.successRate * 100) + '%').padStart(7);
      const line = ` ${icon} ${p} ${String(row.fileCount).padStart(5)} ${String(row.scans).padStart(5)} ${yieldStr} ${successStr}`;

      if (row.isCurrent) {
        lines.push(`{bold}{white-fg}${line}{/white-fg}{/bold}`);
      } else {
        lines.push(line);
      }
    }

    return lines;
  }

  private renderSplitMapContent(): void {
    this.splitMapPane.setContent(this.buildSectorMapContent().join('\n'));
  }

  private renderSectorOverlay(): void {
    this.sectorOverlay.setContent(this.buildSectorMapContent().join('\n'));
  }

  destroy(): void {
    this.destroyed = true;
    if (this.headerTimer) {
      clearInterval(this.headerTimer);
      this.headerTimer = null;
    }
    this.writeLog(`\nSession ended at ${new Date().toISOString()}\n`);
    this.logStream?.end();
    this.logStream = null;
    this.screen.destroy();
  }
}
