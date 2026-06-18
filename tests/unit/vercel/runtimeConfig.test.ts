import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('vercel runtime config', () => {
  it('pins the Vercel API runtime below Node 24 until the platform adapter no longer emits DEP0169', () => {
    const packageJson = JSON.parse(readFileSync('vercel-api/package.json', 'utf8')) as {
      engines?: { node?: string };
    };
    const packageLock = JSON.parse(readFileSync('vercel-api/package-lock.json', 'utf8')) as {
      packages?: { '': { engines?: { node?: string } } };
    };
    const workflow = readFileSync('.github/workflows/vercel-control-plane.yml', 'utf8');

    expect(packageJson.engines?.node).toBe('22.x');
    expect(packageLock.packages?.[''].engines?.node).toBe('22.x');
    expect(workflow).toContain('node-version: 22');
    expect(workflow).not.toContain('node-version: 24');
  });
});
