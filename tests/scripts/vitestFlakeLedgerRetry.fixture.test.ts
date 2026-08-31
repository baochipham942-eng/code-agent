import { existsSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('is stable until the ledger mutation asks for one retry', () => {
  if (process.env.N_FLAKE_LEDGER_ALWAYS_FAIL) {
    throw new Error('intentional persistent failure for exit-code passthrough');
  }
  const marker = process.env.N_FLAKE_LEDGER_RETRY_FILE;
  if (marker && !existsSync(marker)) {
    writeFileSync(marker, 'first attempt failed');
    throw new Error('intentional first attempt failure for flake ledger mutation');
  }
  expect(true).toBe(true);
});
