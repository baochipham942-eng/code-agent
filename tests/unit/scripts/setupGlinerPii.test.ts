// ============================================================================
// setup-gliner-pii.mjs（Node 版 PII 安装链，macOS/Windows 双平台）可测函数
// - venv python 路径按平台（POSIX bin/python / Windows Scripts\python.exe）
// - uv 二进制名按平台
// - .env 重写：剔除旧 PII 配置、保留其他 key、追加新配置块（与原 .sh 版
//   grep -vE '^CODE_AGENT_(PII_ENTITY|GLINER_PII)' 同语义）
// ============================================================================

import { describe, expect, it } from 'vitest';
// @ts-expect-error — 纯 ESM 脚本无类型声明
import { venvPythonPath, uvBinaryName, buildEnvContent } from '../../../scripts/pii/setup-gliner-pii.mjs';

describe('setup-gliner-pii platform helpers', () => {
  it('resolves venv python per platform', () => {
    expect(venvPythonPath('/cache/.venv', 'darwin')).toBe('/cache/.venv/bin/python');
    expect(venvPythonPath('/cache/.venv', 'linux')).toBe('/cache/.venv/bin/python');
    // path.join 在当前平台跑出的分隔符：只断言结尾形态
    expect(venvPythonPath('C:\\cache\\.venv', 'win32').endsWith(`Scripts${process.platform === 'win32' ? '\\' : '/'}python.exe`)).toBe(true);
  });

  it('resolves uv binary name per platform', () => {
    expect(uvBinaryName('darwin')).toBe('uv');
    expect(uvBinaryName('win32')).toBe('uv.exe');
  });
});

describe('buildEnvContent', () => {
  const PII_VARS = {
    CODE_AGENT_PII_ENTITY_DETECTOR: 'gliner-onnx-command',
    CODE_AGENT_GLINER_PII_MODEL: '/models/gliner',
  };

  it('appends pii vars to empty env', () => {
    const content = buildEnvContent('', PII_VARS);
    expect(content).toBe(
      'CODE_AGENT_PII_ENTITY_DETECTOR=gliner-onnx-command\nCODE_AGENT_GLINER_PII_MODEL=/models/gliner\n',
    );
  });

  it('preserves unrelated keys and replaces stale pii config', () => {
    const existing = [
      'HTTPS_PROXY=http://127.0.0.1:7897',
      'CODE_AGENT_PII_ENTITY_DETECTOR=old-detector',
      'CODE_AGENT_GLINER_PII_MODEL=/old/model',
      'OPENAI_API_KEY=sk-test',
    ].join('\n');

    const content = buildEnvContent(existing, PII_VARS);
    expect(content).toContain('HTTPS_PROXY=http://127.0.0.1:7897');
    expect(content).toContain('OPENAI_API_KEY=sk-test');
    expect(content).not.toContain('old-detector');
    expect(content).not.toContain('/old/model');
    expect(content).toContain('CODE_AGENT_GLINER_PII_MODEL=/models/gliner');
    // 旧 PII 行恰好被剔一次，新块只出现一次
    expect(content.match(/CODE_AGENT_PII_ENTITY_DETECTOR=/g)).toHaveLength(1);
  });

  it('keeps comments and ends with a single trailing newline', () => {
    const content = buildEnvContent('# proxy config\nFOO=bar\n\n', PII_VARS);
    expect(content.startsWith('# proxy config\nFOO=bar\n')).toBe(true);
    expect(content.endsWith('\n')).toBe(true);
    expect(content.endsWith('\n\n')).toBe(false);
  });
});
