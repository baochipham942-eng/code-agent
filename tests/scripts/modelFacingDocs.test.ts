import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkModelFacingDocs } from '../../scripts/check-model-facing-docs.mjs';

const repoRoot = path.resolve(__dirname, '../..');
const docPath = path.join(repoRoot, 'docs/architecture/model-facing-surface.md');

const requiredHeadings = [
  '### What the model sees',
  '### Token impact',
  '### KV-cache impact',
  '### Known limits',
];

function validDoc(): string {
  return fs.readFileSync(docPath, 'utf8');
}

describe('model-facing surface document checker', () => {
  it('accepts the real document', () => {
    const result = checkModelFacingDocs(validDoc(), repoRoot);
    expect(result.ok).toBe(true);
    expect(result.entryCount).toBe(3);
    expect(result.missingPaths).toEqual([]);
  });

  it('rejects an entry with a missing required heading', () => {
    const bad = validDoc().replace(`${requiredHeadings[3]}\n`, '');
    const result = checkModelFacingDocs(bad, repoRoot);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('requires headings in order'))).toBe(true);
  });

  it('rejects an entry whose required headings are out of order', () => {
    const source = validDoc();
    const firstEntryStart = source.indexOf('## Bash core tool');
    const nextEntryStart = source.indexOf('## Skill meta tool');
    const firstEntry = source.slice(firstEntryStart, nextEntryStart);
    const swapped = firstEntry
      .replace('### Token impact', '### __token-impact__')
      .replace('### KV-cache impact', '### Token impact')
      .replace('### __token-impact__', '### KV-cache impact');
    const bad = source.slice(0, firstEntryStart) + swapped + source.slice(nextEntryStart);
    const result = checkModelFacingDocs(bad, repoRoot);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('requires headings in order'))).toBe(true);
  });

  it('rejects a backticked source path that does not exist', () => {
    const bad = validDoc().replace(
      '`src/host/tools/modules/shell/bash.ts`',
      '`src/host/tools/modules/shell/does-not-exist.ts`',
    );
    const result = checkModelFacingDocs(bad, repoRoot);
    expect(result.ok).toBe(false);
    expect(result.missingPaths).toContain('src/host/tools/modules/shell/does-not-exist.ts');
  });
});
