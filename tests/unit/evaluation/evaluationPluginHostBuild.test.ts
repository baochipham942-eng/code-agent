import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  hostSdkStubPlugin,
  normalizeHostModuleSpecifier,
} from '../../../packages/internal/evaluation-center/scripts/host-sdk-stub-plugin';

const repositoryRoot = process.cwd();
const hostRoot = path.join(repositoryRoot, 'src/host');

describe('evaluation-center host SDK build boundary', () => {
  it('normalizes relative and alias imports to the same host SDK key', () => {
    const relative = normalizeHostModuleSpecifier(
      '../../model/quickModel',
      path.join(hostRoot, 'testing/fixtures'),
      hostRoot,
    );
    const alias = normalizeHostModuleSpecifier('@host/model/quickModel', repositoryRoot, hostRoot);
    expect(relative).toBe('@host/model/quickModel');
    expect(alias).toBe(relative);
  });

  it('fails the build for an unexposed host module', async () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'evaluation-host-sdk-'));
    const hostSdkSource = path.join(fixtureRoot, 'internalHostSdk.ts');
    writeFileSync(hostSdkSource, `const modules = {
  '@host/agent/exposedButMissing': {},
};\n`);

    try {
      await expect(esbuild.build({
        stdin: {
          contents: "import '@host/agent/notExposed';",
          resolveDir: path.join(repositoryRoot, 'packages/internal/evaluation-center/src/host'),
          sourcefile: 'unexposed-host.ts',
          loader: 'ts',
        },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        write: false,
        logLevel: 'silent',
        plugins: [hostSdkStubPlugin({ repositoryRoot, hostSdkSource })],
      })).rejects.toThrow(/插件引用了未暴露的宿主模块 @host\/agent\/notExposed/u);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
