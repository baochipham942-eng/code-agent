import fs from 'fs';
import { installLogPath } from './layout';

export function appendInstallLog(root: string, at: Date, line: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.appendFileSync(installLogPath(root), `[${at.toISOString()}] ${line}\n`);
}
