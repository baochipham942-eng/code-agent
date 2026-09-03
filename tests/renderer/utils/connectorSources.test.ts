import { describe, expect, it } from 'vitest';
import { buildExpertConnectorSource } from '../../../src/renderer/utils/connectorSources';

const installed = new Map<string, { kind: 'connector' | 'mcp'; connected: boolean; enabled: boolean }>([
  ['tmeet', { kind: 'connector', connected: true, enabled: true }],
  ['lark', { kind: 'mcp', connected: false, enabled: true }],
  ['notion', { kind: 'mcp', connected: true, enabled: false }],
]);

const resolveLabel = (id: string) => ({ tmeet: '腾讯会议', lark: '飞书', notion: 'Notion' }[id] ?? id);

function build(args: Partial<Parameters<typeof buildExpertConnectorSource>[0]> = {}) {
  return buildExpertConnectorSource({
    expertConnectors: [{ id: 'tmeet', level: 'core', reason: '读取会议纪要，整理进周报' }],
    sessionSelectedIds: [],
    installed,
    resolveLabel,
    ...args,
  });
}

describe('buildExpertConnectorSource', () => {
  it('专家没声明连接器：底栏不多那一颗', () => {
    expect(build({ expertConnectors: undefined })).toBeNull();
    expect(build({ expertConnectors: [] })).toBeNull();
  });

  it('只声明了 optional：默认关，不进底栏', () => {
    expect(build({ expertConnectors: [{ id: 'lark', level: 'optional' }] })).toBeNull();
  });

  it('用户没手选：专家 core 这一轮生效，逐条带名字、理由、状态', () => {
    const source = build();
    expect(source?.sessionOverridden).toBe(false);
    expect(source?.items).toEqual([
      { id: 'tmeet', kind: 'connector', label: '腾讯会议', reason: '读取会议纪要，整理进周报', status: 'connected' },
    ]);
    expect(source?.hasIssue).toBe(false);
  });

  it('用户在本会话手选过连接器：专家那支让位，仍露出但标明这轮不生效', () => {
    const source = build({ sessionSelectedIds: ['feishu'] });
    // 露出（爸拍板：不可移除、要看得见专家在用什么），但不撒谎说它生效
    expect(source?.items.map((item) => item.id)).toEqual(['tmeet']);
    expect(source?.sessionOverridden).toBe(true);
  });

  it('状态三分：已连接 / 未连接 / 已在能力中心关闭；任一条有问题就挂警示点', () => {
    const source = build({
      expertConnectors: [
        { id: 'tmeet', level: 'core' },
        { id: 'lark', level: 'core' },
        { id: 'notion', level: 'core' },
        { id: 'unknown-one', level: 'core' },
      ],
    });
    expect(source?.items.map((item) => [item.id, item.status])).toEqual([
      ['tmeet', 'connected'],
      ['lark', 'disconnected'],
      ['notion', 'hub_off'],
      ['unknown-one', 'disconnected'],
    ]);
    expect(source?.hasIssue).toBe(true);
  });

  it('装在哪一侧就跳哪一侧：CLI 连接器走 connector，其余（含没装过的）走 mcp', () => {
    const source = build({
      expertConnectors: [
        { id: 'tmeet', level: 'core' },
        { id: 'lark', level: 'core' },
        { id: 'never-installed', level: 'core' },
      ],
    });
    expect(source?.items.map((item) => [item.id, item.kind])).toEqual([
      ['tmeet', 'connector'],
      ['lark', 'mcp'],
      ['never-installed', 'mcp'],
    ]);
  });

  it('查不到目录名就退回 id，不让底栏出现空标签', () => {
    const source = build({
      expertConnectors: [{ id: 'unknown-one', level: 'core' }],
      resolveLabel: (id: string) => id,
    });
    expect(source?.items[0]?.label).toBe('unknown-one');
  });
});
