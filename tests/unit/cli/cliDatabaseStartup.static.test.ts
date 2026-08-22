import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');

describe('CLI database startup', () => {
  it('installs the bootstrap busy timeout before the first shared-database pragma', () => {
    const source = readFileSync(path.join(root, 'src/cli/database.ts'), 'utf8');
    const open = source.indexOf(
      'new DatabaseCtor(this.dbPath, { timeout: SERVICE_TIMEOUTS.BOOTSTRAP })',
    );
    const wal = source.indexOf("this.db.pragma('journal_mode = WAL')", open);

    expect(open).toBeGreaterThan(0);
    expect(wal).toBeGreaterThan(open);
  });
});
