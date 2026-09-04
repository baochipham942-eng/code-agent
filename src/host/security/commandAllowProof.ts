import * as path from 'node:path';
import { commandWords } from './commandSafety';

const PRIVILEGE_OR_IDENTITY_WRAPPERS = new Set(['sudo', 'doas', 'su']);
const SIMPLE_ALLOW_WRAPPERS = new Set(['command', 'exec', 'nohup', 'time', 'setsid']);

function commandProgram(word: string | undefined): string {
  return word ? path.posix.basename(word) : '';
}

/**
 * Return an expected command only when it is anchored after transparent wrappers.
 *
 * Ask/deny rules may scan the whole segment. Positive allow proofs are stricter:
 * they may peel only wrappers that do not change identity or environment, and
 * privilege wrappers anywhere in the segment invalidate the proof. Unfamiliar
 * wrapper options stay fail-closed instead of being guessed.
 */
export function anchoredAllowCommandWords(command: string, expectedProgram: string): string[] | null {
  const words = commandWords(command) ?? [];
  if (words.length === 0) return null;
  if (words.some((word) => PRIVILEGE_OR_IDENTITY_WRAPPERS.has(commandProgram(word)))) return null;

  let index = 0;
  while (index < words.length) {
    const program = commandProgram(words[index]);
    if (SIMPLE_ALLOW_WRAPPERS.has(program)) {
      index += 1;
      if (words[index] === '--') index += 1;
      continue;
    }

    // A bare `env` is transparent. Any option or NAME=value changes the
    // execution environment, so it cannot participate in an allow proof.
    if (program === 'env') {
      index += 1;
      if (words[index] === '--') index += 1;
      const next = words[index];
      if (!next || next.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) return null;
      continue;
    }
    break;
  }

  return commandProgram(words[index]) === expectedProgram ? words.slice(index) : null;
}
