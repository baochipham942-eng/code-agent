import { describe, expect, it } from 'vitest';
import {
  CRON_TEMPLATES,
  getMissingTemplateConnectors,
  getTemplateConnectorStatuses,
} from '../../../src/renderer/components/features/cron/cronTemplates';

describe('CRON_TEMPLATES 里真实的连接器依赖标注', () => {
  it('只有两个飞书监听模板声明 lark 依赖，其余模板不声明', () => {
    const withDeps = CRON_TEMPLATES
      .filter((template) => (template.requiredConnectors?.length ?? 0) > 0)
      .map((template) => ({ id: template.id, requiredConnectors: template.requiredConnectors }));
    expect(withDeps).toEqual([
      { id: 'feishu-calendar-conflict', requiredConnectors: ['lark'] },
      { id: 'feishu-table-change', requiredConnectors: ['lark'] },
    ]);
  });
});

describe('getTemplateConnectorStatuses', () => {
  it('无依赖模板返回空数组', () => {
    expect(getTemplateConnectorStatuses({ requiredConnectors: undefined }, new Set())).toEqual([]);
    expect(getTemplateConnectorStatuses({ requiredConnectors: [] }, new Set())).toEqual([]);
  });

  it('依赖已连接：connected 为 true，label 取自 mcpCatalog', () => {
    const statuses = getTemplateConnectorStatuses(
      { requiredConnectors: ['lark'] },
      new Set(['lark']),
    );
    expect(statuses).toEqual([{ id: 'lark', label: '飞书', connected: true }]);
  });

  it('依赖未连接：connected 为 false', () => {
    const statuses = getTemplateConnectorStatuses(
      { requiredConnectors: ['lark'] },
      new Set(),
    );
    expect(statuses).toEqual([{ id: 'lark', label: '飞书', connected: false }]);
  });

  it('catalog 里查不到的 id 兜底用 id 本身当 label', () => {
    const statuses = getTemplateConnectorStatuses(
      { requiredConnectors: ['unknown-connector'] },
      new Set(),
    );
    expect(statuses).toEqual([{ id: 'unknown-connector', label: 'unknown-connector', connected: false }]);
  });
});

describe('getMissingTemplateConnectors', () => {
  it('过滤出未连接的项，保留连接的不出现', () => {
    const missing = getMissingTemplateConnectors([
      { id: 'lark', label: '飞书', connected: false },
      { id: 'notion', label: 'Notion', connected: true },
    ]);
    expect(missing).toEqual([{ id: 'lark', label: '飞书', connected: false }]);
  });

  it('全部已连接时返回空数组', () => {
    expect(getMissingTemplateConnectors([{ id: 'lark', label: '飞书', connected: true }])).toEqual([]);
  });
});
