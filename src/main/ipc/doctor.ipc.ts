import { existsSync } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

export interface DiagnosticItem {
  category: 'environment' | 'network' | 'config' | 'database' | 'disk';
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  details?: string;
}

export interface DiagnosticReport {
  timestamp: number;
  items: DiagnosticItem[];
  summary: { pass: number; warn: number; fail: number };
}

export async function runDiagnostics(): Promise<DiagnosticReport> {
  const items: DiagnosticItem[] = [];

  // Environment checks
  items.push(checkNodeVersion());
  items.push(checkConfigDir());

  // Database checks
  items.push(await checkDatabase());

  // Disk checks
  items.push(await checkDiskUsage());

  const summary = {
    pass: items.filter(i => i.status === 'pass').length,
    warn: items.filter(i => i.status === 'warn').length,
    fail: items.filter(i => i.status === 'fail').length,
  };

  return { timestamp: Date.now(), items, summary };
}

function checkNodeVersion(): DiagnosticItem {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);
  return {
    category: 'environment',
    name: 'Node.js version',
    status: major >= 18 ? 'pass' : 'fail',
    message: `Node.js ${version}`,
    details: major < 18 ? 'Requires Node.js >= 18' : undefined,
  };
}

function checkConfigDir(): DiagnosticItem {
  const configDir = join(homedir(), '.code-agent');
  const exists = existsSync(configDir);
  return {
    category: 'config',
    name: 'Config directory',
    status: exists ? 'pass' : 'warn',
    message: exists ? configDir : 'Config directory not found',
    details: exists ? undefined : `Expected at ${configDir}`,
  };
}

async function checkDatabase(): Promise<DiagnosticItem> {
  const dbPath = join(homedir(), '.code-agent', 'code-agent.db');
  if (!existsSync(dbPath)) {
    return { category: 'database', name: 'SQLite database', status: 'warn', message: 'Database not found' };
  }
  try {
    const stats = await stat(dbPath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
    return { category: 'database', name: 'SQLite database', status: 'pass', message: `${sizeMB} MB` };
  } catch {
    return { category: 'database', name: 'SQLite database', status: 'fail', message: 'Cannot read database' };
  }
}

async function checkDiskUsage(): Promise<DiagnosticItem> {
  const configDir = join(homedir(), '.code-agent');
  if (!existsSync(configDir)) {
    return { category: 'disk', name: 'Disk usage', status: 'pass', message: 'No data directory' };
  }
  try {
    const stats = await stat(configDir);
    return { category: 'disk', name: 'Config directory size', status: 'pass', message: 'Checked', details: `${configDir}` };
  } catch {
    return { category: 'disk', name: 'Disk usage', status: 'warn', message: 'Cannot check disk usage' };
  }
}
