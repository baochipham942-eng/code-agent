// ============================================================================
// 域路由表 parity 门（RQ-183 刀 1 骨架）——结构枚举断言
// ============================================================================
//
// sessionActionSurfacesParity（源码正则 + 括号配对提取三面 case 标签）的泛化继任：
// 表化域的 action 集合可直接枚举（Object.keys(table.actions)），与 schema union 的
// 字面量集合（extractDomainActions 从 zod 提取）做集合相等——不再靠正则。
//
// 本刀（刀 1）只有 demo 表自证门会转；刀 2 起把 sessionRoutes 加进 ROUTE_TABLES，
// 逐步覆盖表化域后取代旧门（旧门删除与新门上线必须在同一 PR，方案 4.3）。
//
// 自举纪律（沿旧门教训）：提取 0 个 action → 报红（锚点失效不假绿）；
// 差集报错指名道姓一次列全（deny-list-by-name 教训）。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { demoRoutes } from '../../src/host/ipc/domainRoutes/demo';
import { extractDomainActions } from '../../src/host/ipc/domainRoutes/registry';

/** 门盯的表清单——新域表化后加进来，门即自动覆盖该域 */
const ROUTE_TABLES = [demoRoutes];

describe('域路由表 parity 门', () => {
  it('门自举：表清单非空（清单空了门就是摆设）', () => {
    expect(ROUTE_TABLES.length).toBeGreaterThan(0);
  });

  for (const table of ROUTE_TABLES) {
    describe(table.channel, () => {
      it('自举：表与 schema 两侧都提取到 action（提取 0 个即红）', () => {
        const tableActions = Object.keys(table.actions);
        expect(
          tableActions.length,
          `${table.channel} 的表提取到 0 个 action——表结构变了，更新本门`,
        ).toBeGreaterThan(0);
        const schemaActions = extractDomainActions(table.requestSchema.payload);
        expect(
          schemaActions.size,
          `${table.channel} 的 schema 提取到 0 个 action——schema 形态不被 extractDomainActions 认识，先修提取器`,
        ).toBeGreaterThan(0);
      });

      it('表 Object.keys(actions) == schema union 的 action 字面量集合', () => {
        const tableActions = new Set(Object.keys(table.actions));
        const schemaActions = extractDomainActions(table.requestSchema.payload);
        const problems: string[] = [];
        for (const action of new Set([...tableActions, ...schemaActions])) {
          const missing = [
            !tableActions.has(action) ? '表' : '',
            !schemaActions.has(action) ? 'schema' : '',
          ].filter(Boolean);
          if (missing.length) problems.push(`  ${action} → 缺 ${missing.join(' / ')}`);
        }
        expect(
          problems,
          `${table.channel} 表与 schema 的 action 集合不等：\n${problems.join('\n')}`,
        ).toEqual([]);
      });
    });
  }
});
