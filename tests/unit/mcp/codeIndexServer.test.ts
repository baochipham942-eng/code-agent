import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import type { EvidenceRef } from '../../../src/shared/contract/evidence';
import { createCodeIndexServer } from '../../../src/host/mcp/servers/codeIndexServer';

let tempDir: string | undefined;

async function makeRepo(): Promise<string> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'code-index-test-'));
  const srcDir = path.join(tempDir, 'src');
  await mkdir(srcDir, { recursive: true });
  await writeFile(
    path.join(srcDir, 'alpha.ts'),
    [
      'export class AlphaService {',
      '  loginUser(email: string) {',
      '    return `welcome ${email}`;',
      '  }',
      '}',
      '',
      'export function buildLoginPayload(email: string) {',
      '  return { email, flow: "login" };',
      '}',
    ].join('\n'),
  );
  return tempDir;
}

describe('CodeIndexServer code_search', () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('returns an index-first hint without the removed memory service message', async () => {
    const server = createCodeIndexServer();
    await server.start();

    const result = await server.callTool('code_search', { query: 'AlphaService' }, 'search-1');

    expect(result.success).toBe(true);
    expect(result.output).toContain('Run code_index first');
    expect(result.output).not.toContain('memory service has been removed');
  });

  it('searches indexed code with lexical and symbol matches marked as candidate evidence', async () => {
    const repo = await makeRepo();
    const server = createCodeIndexServer();
    await server.start();

    const indexResult = await server.callTool(
      'code_index',
      { path: repo, pattern: '**/*.ts' },
      'index-1',
    );
    expect(indexResult.success).toBe(true);

    const result = await server.callTool(
      'code_search',
      { query: 'AlphaService login', limit: 3 },
      'search-2',
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('lexical FTS + symbol search');
    expect(result.output).toContain('EvidenceRef');
    expect(result.output).toContain('"state":"candidate"');
    expect(result.output).toContain('Next read: Read');
    expect(result.output).not.toContain('memory service has been removed');

    const refs = result.metadata?.evidenceRefs as EvidenceRef[] | undefined;
    expect(refs?.length).toBeGreaterThan(0);
    expect(refs?.[0].freshness.state).toBe('candidate');
    expect(refs?.[0].source).toBe('code_search');
  });
});
