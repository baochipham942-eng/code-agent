import fs from 'node:fs/promises';
import { scoreInspectCase, type InspectAssertionContext } from './inspectBridge';
import type { TestCase } from '../../src/host/testing/types';

interface ScoreRequest {
  case: TestCase;
  context: Omit<InspectAssertionContext, 'workingDirectory'>;
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  const workingDirectory = process.argv[3];
  if (!inputPath || !workingDirectory) {
    throw new Error('Usage: score-case.ts <input.json> <working-directory>');
  }
  const request = JSON.parse(await fs.readFile(inputPath, 'utf8')) as ScoreRequest;
  const result = await scoreInspectCase(request.case, {
    ...request.context,
    workingDirectory,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
