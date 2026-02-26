/**
 * Solo inspect command composition: scout, status, history, formulas, export, artifacts, approve
 */

import { Command } from 'commander';
import { registerInspectScoutCommand } from './inspect-scout.js';
import { registerInspectStatusCommand } from './inspect-status.js';
import { registerInspectHistoryCommand } from './inspect-history.js';
import { registerInspectFormulasCommand } from './inspect-formulas.js';
import { registerInspectExportCommand } from './inspect-export.js';
import { registerInspectArtifactsCommand } from './inspect-artifacts.js';
import { registerInspectApproveCommand } from './inspect-approve.js';

export function registerInspectCommands(solo: Command): void {
  registerInspectScoutCommand(solo);
  registerInspectStatusCommand(solo);
  registerInspectHistoryCommand(solo);
  registerInspectFormulasCommand(solo);
  registerInspectExportCommand(solo);
  registerInspectArtifactsCommand(solo);
  registerInspectApproveCommand(solo);
}
