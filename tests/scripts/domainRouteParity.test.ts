// ============================================================================
// 域路由表 parity 门（RQ-183）——结构枚举断言
// ============================================================================
//
// sessionActionSurfacesParity（源码正则 + 括号配对提取三面 case 标签）的泛化继任：
// 表化域的 action 集合可直接枚举（Object.keys(table.actions)），与 schema union 的
// 字面量集合（extractDomainActions 从 zod 提取）做集合相等——不再靠正则。
//
// 已表化域（session）另做三面对账：表 keys == schema == shellCapabilities 域集合
// （新 action 三处一起改）；web:false 暂缓清单对 KNOWN 基线只减不增。
//
// 自举纪律（沿旧门教训）：提取 0 个 action → 报红（锚点失效不假绿）；
// 差集报错指名道姓一次列全（deny-list-by-name 教训）。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { channelSchema } from '../../src/shared/ipc/schemas/core';
import {
  defineSessionRoutes,
  sessionRoutes,
} from '../../src/host/ipc/domainRoutes/sessionRoutes';
import { defineDomainRoutes, installDomainRoutes } from '../../src/host/ipc/domainRoutes/registry';
import { getShellCapabilities } from '../../src/host/shellCapabilities';

// 结构枚举器挂既有函数对象上（knip 生产档无测试入口，独立 export 必成 dead export）
const { extractDomainActions } = installDomainRoutes;

/** 门盯的表清单——新域表化后加进来，门即自动覆盖该域（session 三面走 manifestDomain 断言） */
const ROUTE_TABLES = [
  { table: sessionRoutes, manifestDomain: 'domain:session' as const },
  { table: inlineFixtureTable(), manifestDomain: undefined },
];

/** 内联最小表 fixture（原 demo.ts 折叠进来）：门自证「会转」的最小样本，非生产域 */
function inlineFixtureTable() {
  interface FixtureCtx {
    prefix: string;
  }
  const FixtureRequestSchema = z.object({
    action: z.enum(['echo', 'ping']),
    payload: z.unknown().optional(),
    requestId: z.string().optional(),
  });
  return defineDomainRoutes(
    channelSchema({ channel: 'domain:fixture', payload: FixtureRequestSchema }),
    {
      // ctx 显式注解：Ctx 在 handler 签名的逆变位，靠字面量推断不出具体类型
      echo: async (ctx: FixtureCtx, payload) => ({ message: `${ctx.prefix}:${String(payload ?? '')}` }),
      ping: async (ctx: FixtureCtx) => ({ pong: ctx.prefix }),
    },
  );
}

/**
 * 已知存量缺口（旧门 2026-07-26 实测挖出，刀 2 基线平移、数量不变）：
 * 以下 5 个 action 是 desktop-only gap——在 web 形态表里是 INVALID_ACTION 桩，
 * 发行版全走 web 形态，等于这些能力在生产是死的（刀 3 逐个补齐后清零）。
 * 基线只减不增：修一个必须同步删掉一行，否则报红（自收紧棘轮）。
 */
const KNOWN_PENDING_WEB_ACTIONS = new Set([
  'exportDiagnostics',
  'exportMarkdown',
  'getMemoryContext',
  'import',
  'search',
]);

describe('域路由表 parity 门', () => {
  it('门自举：表清单非空（清单空了门就是摆设）', () => {
    expect(ROUTE_TABLES.length).toBeGreaterThan(0);
  });

  for (const { table, manifestDomain } of ROUTE_TABLES) {
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

      if (manifestDomain) {
        it('三面一致：表 keys == schema == shellCapabilities 域集合（新 action 三处一起改）', () => {
          const tableActions = new Set(Object.keys(table.actions));
          const schemaActions = extractDomainActions(table.requestSchema.payload);
          const manifestActions = new Set(
            getShellCapabilities()
              .filter((capability) => capability.domain === manifestDomain)
              .map((capability) => capability.action),
          );
          expect(manifestActions.size, `${manifestDomain} 在 shellCapabilities 提取到 0 个 action——清单或锚点失效`).toBeGreaterThan(0);
          const problems: string[] = [];
          for (const action of new Set([...tableActions, ...schemaActions, ...manifestActions])) {
            const missing = [
              !tableActions.has(action) ? '表' : '',
              !schemaActions.has(action) ? 'schema' : '',
              !manifestActions.has(action) ? 'shellCapabilities' : '',
            ].filter(Boolean);
            if (missing.length) problems.push(`  ${action} → 缺 ${missing.join(' / ')}`);
          }
          expect(
            problems,
            `${manifestDomain} 三面 action 集合不等（表 / schema / shellCapabilities）：\n${problems.join('\n')}`,
          ).toEqual([]);
        });
      }
    });
  }

  describe('domain:session web:false 暂缓棘轮', () => {
    const webTable = defineSessionRoutes('web');
    const canonicalActions = new Set(Object.keys(sessionRoutes.actions));

    it('标记集合 == 基线（只减不增；补齐一个必须同步删基线）', () => {
      const marked = new Set<string>(webTable.disabledActions ?? []);
      expect(
        [...marked].filter((action) => !KNOWN_PENDING_WEB_ACTIONS.has(action)),
        '新增了 web:false 标记——基线外不许加，先更新 KNOWN_PENDING_WEB_ACTIONS',
      ).toEqual([]);
      expect(
        [...KNOWN_PENDING_WEB_ACTIONS].filter((action) => !marked.has(action)),
        '基线里有但标记集合没有——标记与基线漂移，两边对齐',
      ).toEqual([]);
    });

    it('每个暂缓 action 都在全量表里有真实现（刀 3 清标记时必须有 handler 可接）', () => {
      expect(
        [...KNOWN_PENDING_WEB_ACTIONS].filter((action) => !canonicalActions.has(action)),
        '全量表缺基线 action——基线过期，更新它',
      ).toEqual([]);
    });

    it('web 形态表的 disabledActions 标记与基线一致（装配面与声明面不漂移）', () => {
      expect(new Set(webTable.disabledActions ?? [])).toEqual(KNOWN_PENDING_WEB_ACTIONS);
    });
  });
});
