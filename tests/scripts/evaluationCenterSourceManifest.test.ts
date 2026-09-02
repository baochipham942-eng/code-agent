import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const manifestPath = path.resolve(
  import.meta.dirname,
  '../../packages/internal/evaluation-center/plugin.json',
);
const restoreCommand = 'git restore -- packages/internal/evaluation-center/plugin.json';

interface SourceManifest {
  version?: unknown;
  internalFeature?: {
    sdkVersion?: {
      host?: unknown;
      renderer?: unknown;
    };
    builtFrom?: unknown;
  };
}

function leakageMessage(detail: string): string {
  return [
    `构建产物泄漏回源码：${manifestPath} ${detail}。`,
    '源码只允许 unbuilt 占位，真实构建指纹只进 dist/。',
    `恢复命令：${restoreCommand}`,
  ].join(' ');
}

describe('evaluation-center source manifest guard', () => {
  it('keeps the tracked plugin.json on unbuilt placeholders', async () => {
    let source: string;
    try {
      source = await fs.readFile(manifestPath, 'utf8');
    } catch (error) {
      throw new Error(leakageMessage('无法读取，静态门无法确认源码占位契约'), { cause: error });
    }

    let manifest: SourceManifest;
    try {
      manifest = JSON.parse(source) as SourceManifest;
    } catch (error) {
      throw new Error(leakageMessage('不是合法 JSON，静态门无法确认源码占位契约'), { cause: error });
    }

    expect(manifest.version, leakageMessage('的 version 被盖入真实版本')).toBe('0.0.0-unbuilt');
    expect(
      manifest.internalFeature?.sdkVersion?.host,
      leakageMessage('的 internalFeature.sdkVersion.host 被盖入真实哈希'),
    ).toBe('unbuilt');
    expect(
      manifest.internalFeature?.sdkVersion?.renderer,
      leakageMessage('的 internalFeature.sdkVersion.renderer 被盖入真实哈希'),
    ).toBe('unbuilt');
    expect(
      manifest.internalFeature,
      leakageMessage('出现了只属于构建产物的 internalFeature.builtFrom'),
    ).not.toHaveProperty('builtFrom');
  });
});
