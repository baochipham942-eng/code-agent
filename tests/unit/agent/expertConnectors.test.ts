// ============================================================================
// 专家推荐连接器：frontmatter 解析 + 会话层三态解析（D-2）
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  parseExpertConnectors,
  resolveSessionConnectorIds,
} from '../../../src/shared/contract/expertConnectors';
import { parseAgentMd } from '../../../src/host/agent/hybrid/agentMdLoader';

describe('parseExpertConnectors', () => {
  it('按竖线切出 id / 档位 / 理由', () => {
    expect(parseExpertConnectors(['lark|core|从多维表格取排期'])).toEqual([
      { id: 'lark', level: 'core', reason: '从多维表格取排期' },
    ]);
  });

  it('档位缺省或写错一律当 optional（默认关是安全的那一侧）', () => {
    expect(parseExpertConnectors(['github', 'notion|CORE', 'excel|随便写'])).toEqual([
      { id: 'github', level: 'optional' },
      { id: 'notion', level: 'core' },
      { id: 'excel', level: 'optional' },
    ]);
  });

  it('理由里带竖线不会被截断，重复 id 只留第一条', () => {
    expect(parseExpertConnectors(['lark|core|读表 | 写表', 'lark|optional|重复'])).toEqual([
      { id: 'lark', level: 'core', reason: '读表 | 写表' },
    ]);
  });

  it('没写就是空列表', () => {
    expect(parseExpertConnectors(undefined)).toEqual([]);
    expect(parseExpertConnectors([])).toEqual([]);
  });
});

describe('parseAgentMd connectors 字段', () => {
  it('把 frontmatter 的 connectors 解析进专家配置', () => {
    const content = [
      '---',
      'name: schedule-expert',
      'connectors:',
      '  - lark|core|读飞书多维表格',
      '  - github|optional|偶尔提 PR',
      '---',
      '正文',
    ].join('\n');

    const config = parseAgentMd(content, 'schedule-expert.md');

    expect(config?.connectors).toEqual([
      { id: 'lark', level: 'core', reason: '读飞书多维表格' },
      { id: 'github', level: 'optional', reason: '偶尔提 PR' },
    ]);
  });

  it('没声明 connectors 的专家不长出这个字段（零影响）', () => {
    const content = ['---', 'name: plain', '---', '正文'].join('\n');
    expect(parseAgentMd(content, 'plain.md')?.connectors).toBeUndefined();
  });
});

describe('resolveSessionConnectorIds 三态', () => {
  const expertConnectors = [
    { id: 'lark', level: 'core' as const },
    { id: 'github', level: 'optional' as const },
  ];

  it('专家默认：core 开、optional 关', () => {
    expect(resolveSessionConnectorIds({ expertConnectors })).toEqual(['lark']);
  });

  it('会话覆盖优先：用户在会话里选过就以会话为准，专家声明不抢方向盘', () => {
    expect(resolveSessionConnectorIds({ sessionSelectedIds: ['github'], expertConnectors })).toEqual(['github']);
  });

  it('全局兜底：既没会话选择也没专家声明 → 空数组＝不收窄', () => {
    expect(resolveSessionConnectorIds({})).toEqual([]);
    expect(resolveSessionConnectorIds({ sessionSelectedIds: [], expertConnectors: [] })).toEqual([]);
  });

  it('会话选择里的空白项不算数，也不会被当成「选过」', () => {
    expect(resolveSessionConnectorIds({ sessionSelectedIds: ['  ', ''], expertConnectors })).toEqual(['lark']);
  });
});
