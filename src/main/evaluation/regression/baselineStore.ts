import * as fs from 'node:fs/promises';
import type { Baseline } from './regressionTypes';

export async function readBaseline(filePath: string): Promise<Baseline | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as Baseline;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export async function writeBaseline(filePath: string, baseline: Baseline): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
}
