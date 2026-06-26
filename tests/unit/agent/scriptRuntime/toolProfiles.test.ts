// ============================================================================
// toolProfiles Tests (P2-C 子 agent 工具分档)
//
// 三档白名单：readonly（默认，只读+调研）/ edit（+Edit/Write）/ full（+Bash）。
// 模型脚本经 agent({tools}) 按 agent 选档；host 用本策略解析成注册名 + 标记是否写能力
// （写能力触发并行写护栏）。未知档名直接抛错（schema 文档已列 3 个合法值）。
// ============================================================================

import { describe, it, expect } from 'vitest';
import { resolveToolProfile } from '../../../../src/host/agent/scriptRuntime/toolProfiles';

describe('resolveToolProfile', () => {
  it('defaults to readonly (no write capability)', () => {
    const r = resolveToolProfile();
    expect(r.tools).toEqual(['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep']);
    expect(r.writeCapable).toBe(false);
  });

  it('readonly is the same as default', () => {
    expect(resolveToolProfile('readonly').tools).toEqual(['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep']);
    expect(resolveToolProfile('readonly').writeCapable).toBe(false);
  });

  it('edit adds Edit/Write and is write-capable', () => {
    const r = resolveToolProfile('edit');
    expect(r.tools).toContain('Edit');
    expect(r.tools).toContain('Write');
    expect(r.tools).not.toContain('Bash');
    expect(r.writeCapable).toBe(true);
  });

  it('full adds Bash on top of edit and is write-capable', () => {
    const r = resolveToolProfile('full');
    expect(r.tools).toContain('Edit');
    expect(r.tools).toContain('Bash');
    expect(r.writeCapable).toBe(true);
  });

  it('throws on an unknown profile', () => {
    expect(() => resolveToolProfile('superuser')).toThrow();
  });
});
