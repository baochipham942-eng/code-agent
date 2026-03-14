#!/usr/bin/env npx tsx

export interface ParsedArgs {
  positionals: string[];
  options: Record<string, string | string[] | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | string[] | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    const hasValue = next !== undefined && !next.startsWith('--');
    const value: string | boolean = hasValue ? next : true;

    if (hasValue) {
      index += 1;
    }

    const existing = options[key];
    if (existing === undefined) {
      options[key] = value;
      continue;
    }

    if (Array.isArray(existing)) {
      existing.push(String(value));
      options[key] = existing;
      continue;
    }

    options[key] = [String(existing), String(value)];
  }

  return { positionals, options };
}

export function hasFlag(args: ParsedArgs, key: string): boolean {
  return args.options[key] !== undefined;
}

export function getStringOption(args: ParsedArgs, key: string): string | undefined {
  const value = args.options[key];
  if (value === undefined || value === true) return undefined;
  if (Array.isArray(value)) return value[value.length - 1];
  return value;
}

export function getStringArrayOption(args: ParsedArgs, key: string): string[] {
  const value = args.options[key];
  if (value === undefined) return [];

  const items = Array.isArray(value) ? value : [String(value)];
  return items
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getNumberOption(args: ParsedArgs, key: string): number | undefined {
  const value = getStringOption(args, key);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function getBooleanOption(args: ParsedArgs, key: string): boolean | undefined {
  const value = args.options[key];
  if (value === undefined) return undefined;
  if (value === true) return true;

  const normalized = String(Array.isArray(value) ? value[value.length - 1] : value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return undefined;
}

export function requireStringOption(args: ParsedArgs, key: string): string {
  const value = getStringOption(args, key);
  if (!value) {
    throw new Error(`Missing required option --${key}`);
  }
  return value;
}

export function formatTimestamp(timestampMs: number | null | undefined): string {
  if (!timestampMs) return 'N/A';
  return new Date(timestampMs).toLocaleString('zh-CN');
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function printKeyValue(title: string, rows: Array<[string, string | number | boolean | null | undefined]>): void {
  console.log(`\n${title}`);
  for (const [key, value] of rows) {
    console.log(`- ${key}: ${value ?? 'N/A'}`);
  }
}

export function finishWithError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}
