// Hand-copied telemetry DDL must go through applyTelemetrySchema
// (src/host/services/core/database/schemaTelemetry.ts). A second copy of
// that table definition under tests/ drifts from the real schema.
// Allowlist stays empty: nothing in tests is allowed to paste that DDL.
// Add a path here only when a fixture cannot call the real schema, and
// write the reason on the same line.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const testsRoot = path.join(repoRoot, 'tests');

const TELEMETRY_DDL_ALLOWLIST = new Set<string>([]);

const TELEMETRY_DDL = new RegExp(
  ['CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+', 'telemetry_'].join(''),
  'i',
);

function listTests(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      listTests(full, acc);
      continue;
    }
    if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) acc.push(full);
  }
}

describe('telemetry DDL drift guard', () => {
  it('rejects a hand-copied telemetry table DDL under tests/', () => {
    const files: string[] = [];
    listTests(testsRoot, files);
    const offenders = files
      .map((file) => path.relative(repoRoot, file).split(path.sep).join('/'))
      .filter((rel) => !TELEMETRY_DDL_ALLOWLIST.has(rel))
      .filter((rel) => TELEMETRY_DDL.test(readFileSync(path.join(repoRoot, rel), 'utf8')));

    expect(offenders, `hand-copied telemetry DDL in:\n${offenders.join('\n')}`).toEqual([]);
  });
});
