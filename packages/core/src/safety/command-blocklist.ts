/**
 * Bash command blocklist — blocks known-dangerous shell patterns.
 *
 * Used by hook-driver.js (PreToolUse) to prevent catastrophic mistakes
 * from rogue agents. This is a blocklist, not an allowlist — preserves
 * agent flexibility while catching destructive commands.
 */

export interface BlocklistEntry {
  pattern: RegExp;
  reason: string;
}

export const COMMAND_BLOCKLIST: BlocklistEntry[] = [
  { pattern: /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+\/(\s|$)/, reason: 'Recursive force-delete from root' },
  { pattern: /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+~\//, reason: 'Recursive force-delete from home directory' },
  { pattern: /\bgit\s+push\s+.*--force\b/, reason: 'Force push can destroy remote history' },
  { pattern: /\bgit\s+push\s+-f\b/, reason: 'Force push can destroy remote history' },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'Hard reset discards uncommitted work' },
  { pattern: /\bgit\s+clean\s+(-\w*f\w*d|-\w*d\w*f)\b/, reason: 'git clean -fd deletes untracked files' },
  { pattern: /\bDROP\s+(TABLE|DATABASE)\b/i, reason: 'SQL DROP is destructive and irreversible' },
  { pattern: /\bchmod\s+777\b/, reason: 'chmod 777 is a security risk' },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh\b/, reason: 'Piping curl to shell is a security risk' },
  { pattern: /\bwget\b.*\|\s*(ba)?sh\b/, reason: 'Piping wget to shell is a security risk' },
  { pattern: /\bmkfs\b/, reason: 'mkfs formats filesystems' },
  { pattern: /\bdd\s+.*\bof=\/dev\//, reason: 'dd to device can destroy data' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: 'Redirecting to block device can destroy data' },
  { pattern: /\b:(){ :\|:& };:/, reason: 'Fork bomb' },
];

export interface CommandSafetyResult {
  blocked: boolean;
  reason?: string;
}

export function checkCommandSafety(command: string): CommandSafetyResult {
  for (const entry of COMMAND_BLOCKLIST) {
    if (entry.pattern.test(command)) {
      return { blocked: true, reason: entry.reason };
    }
  }
  return { blocked: false };
}
