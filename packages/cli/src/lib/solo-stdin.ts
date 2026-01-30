/**
 * Non-blocking stdin listener for live hints during auto mode.
 *
 * When running in a TTY, reads lines from stdin and adds them
 * as hints via the solo-hints module.
 */

import chalk from 'chalk';
import { addHint } from './solo-hints.js';

/**
 * Start listening for hint input on stdin.
 * Returns a cleanup function that stops listening.
 * Only activates when stdin is a TTY.
 */
export function startStdinListener(repoRoot: string): () => void {
  if (!process.stdin.isTTY) {
    return () => {};
  }

  const onData = (data: string) => {
    const text = data.trim();
    if (!text) return;
    const hint = addHint(repoRoot, text);
    console.log(chalk.yellow(`💡 Hint added: "${hint.text}"`));
  };

  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', onData);

  return () => {
    process.stdin.removeListener('data', onData);
    process.stdin.pause();
  };
}
