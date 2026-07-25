// ============================================================================
// agent.md 启动期工具名校验（D-SDK-2）
// 写错工具名此前静默丢弃，现在加载时点名报错。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const { errorSpy, debugSpy } = vi.hoisted(() => ({ errorSpy: vi.fn(), debugSpy: vi.fn() }));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    error: errorSpy,
    debug: debugSpy,
    warn: vi.fn(),
    info: vi.fn(),
  }),
}));

import { loadAgentMdFiles } from '../../../src/host/agent/hybrid/agentMdLoader';
import {
  describeUnknownTools,
  findUnknownToolNames,
  getKnownToolNames,
  hasProtocolToolRegistry,
} from '../../../src/host/tools/knownToolNames';
// 触发 protocolRegistry 的模块副作用，让 getProtocolToolSchemas() 拿到真实注册表
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';

function agentMd(name: string, tools: string[]): string {
  return ['---', `name: ${name}`, 'tools:', ...tools.map((tool) => `  - ${tool}`), '---', 'body'].join('\n');
}

let dir = '';

beforeEach(async () => {
  errorSpy.mockClear();
  debugSpy.mockClear();
  getProtocolRegistry();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmd-tools-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('findUnknownToolNames', () => {
  it('放过注册表里存在的名字', () => {
    expect(findUnknownToolNames(['Read', 'Bash'], new Set(['Read', 'Bash']))).toEqual([]);
  });

  it('挑出不存在的名字，并给出大小写/下划线写法的近似建议', () => {
    const unknown = findUnknownToolNames(['read_TOOL', 'Nonexistent'], new Set(['ReadTool', 'Bash']));
    expect(unknown).toEqual([
      { name: 'read_TOOL', suggestion: 'ReadTool' },
      { name: 'Nonexistent' },
    ]);
  });
});

describe('describeUnknownTools', () => {
  it('点名专家和工具名，并带上建议', () => {
    const message = describeUnknownTools('数据分析师', [{ name: 'Redd', suggestion: 'Read' }, { name: 'Xyz' }]);
    expect(message).toContain('数据分析师');
    expect(message).toContain('Redd');
    expect(message).toContain('Read');
    expect(message).toContain('Xyz');
  });
});

describe('loadAgentMdFiles 工具名校验', () => {
  it('注册表就绪时，工具名写错的专家在加载时被点名报错', async () => {
    expect(hasProtocolToolRegistry()).toBe(true);
    await fs.writeFile(path.join(dir, 'typo.md'), agentMd('typo-expert', ['Read', 'Bashh']));

    const agents = await loadAgentMdFiles(dir);

    // 仍然加载出来（不阻断），但必须留下点名记录
    expect(agents).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, context] = errorSpy.mock.calls[0] as [string, { unknownTools: string[] }];
    expect(message).toContain('typo-expert');
    expect(message).toContain('Bashh');
    expect(context.unknownTools).toEqual(['Bashh']);
  });

  it('工具名全对的专家零影响', async () => {
    await fs.writeFile(path.join(dir, 'ok.md'), agentMd('ok-expert', ['Read', 'Bash', 'Glob']));

    const agents = await loadAgentMdFiles(dir);

    expect(agents).toHaveLength(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('没写 tools 字段时走默认 6 件集，且默认集本身全部有效', async () => {
    await fs.writeFile(path.join(dir, 'plain.md'), ['---', 'name: plain-expert', '---', 'body'].join('\n'));

    const agents = await loadAgentMdFiles(dir);

    expect(agents[0].tools).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']);
    expect(findUnknownToolNames(agents[0].tools, getKnownToolNames())).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
