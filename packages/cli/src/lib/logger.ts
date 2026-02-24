/**
 * Logger implementation for CLI
 */

import chalk from 'chalk';
import type { Logger } from '@promptwheel/core/services';

export interface LoggerOptions {
  verbose?: boolean;
  quiet?: boolean;
  /** Custom output function — routes all log output through this instead of console.log. */
  output?: (msg: string) => void;
}

/**
 * Create a logger instance
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const { verbose = false, quiet = false, output } = opts;
  const write = output ?? ((msg: string) => console.log(msg));
  const writeErr = output ?? ((msg: string) => console.error(msg));

  return {
    debug(msg: string, data?: Record<string, unknown>) {
      if (verbose && !quiet) {
        const dataStr = data ? ` ${JSON.stringify(data)}` : '';
        write(chalk.gray(`[debug] ${msg}${dataStr}`));
      }
    },

    info(msg: string, data?: Record<string, unknown>) {
      if (!quiet) {
        const dataStr = data && verbose ? ` ${JSON.stringify(data)}` : '';
        write(chalk.blue(`[info] ${msg}${dataStr}`));
      }
    },

    warn(msg: string, data?: Record<string, unknown>) {
      const dataStr = data ? ` ${JSON.stringify(data)}` : '';
      write(chalk.yellow(`[warn] ${msg}${dataStr}`));
      },

    error(msg: string, data?: Record<string, unknown>) {
      const dataStr = data ? ` ${JSON.stringify(data)}` : '';
      writeErr(chalk.red(`[error] ${msg}${dataStr}`));
    },
  };
}

/**
 * Silent logger (for tests or quiet mode)
 */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
