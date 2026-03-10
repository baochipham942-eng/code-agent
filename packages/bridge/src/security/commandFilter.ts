import type { BridgeConfig } from '../types';

const BLOCKED_PATTERNS = [
  /rm\s+(-r|-rf|-f)?\s*[\/~]/,
  /sudo\s/,
  /curl\s.*\|\s*(bash|sh)/,
  /wget\s.*\|\s*(bash|sh)/,
  />\s*\/dev\/sd/,
  /mkfs/,
  /dd\s+if=/,
  /chmod\s+-R\s+777/,
  /:\(\)\s*\{.*\}/,
  /\b(?:reboot|shutdown|halt|poweroff)\b/,
  /\b(?:killall|pkill)\b/,
];

function stripCommandPrefix(command: string): string {
  const trimmed = command.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/^(\w+=\S+\s+)*/, '');
}

function getBaseCommand(command: string): string {
  const stripped = stripCommandPrefix(command);
  if (!stripped) {
    return '';
  }
  return (stripped.split(/\s+/)[0] ?? '').replace(/^['"]|['"]$/g, '');
}

function containsShellChaining(command: string): boolean {
  return /(?:&&|\|\||;|\$\(|`)/.test(command);
}

export function validateCommand(command: string, config: BridgeConfig): { allowed: boolean; reason?: string } {
  const trimmed = command.trim();
  if (!trimmed) {
    return { allowed: false, reason: 'Command is empty' };
  }

  const baseCommand = getBaseCommand(trimmed);

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason: `Command blocked by security pattern: ${pattern}` };
    }
  }

  if (containsShellChaining(trimmed) && config.securityLevel !== 'relaxed') {
    return { allowed: false, reason: 'Command chaining and subshells are blocked outside relaxed mode' };
  }

  if (config.commandBlacklist.includes(baseCommand)) {
    return { allowed: false, reason: `Command is blacklisted: ${baseCommand}` };
  }

  const whitelist = new Set(config.commandWhitelist);
  if (config.securityLevel === 'strict') {
    if (!whitelist.has(baseCommand)) {
      return { allowed: false, reason: `Command not in whitelist: ${baseCommand}` };
    }
  }

  if (config.securityLevel === 'normal' && whitelist.size > 0) {
    if (!whitelist.has(baseCommand)) {
      return { allowed: false, reason: `Command not permitted by whitelist: ${baseCommand}` };
    }
  }

  return { allowed: true };
}
