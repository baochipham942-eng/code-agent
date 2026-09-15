// ============================================================================
// 域路由表 parity 门（RQ-183）——结构枚举断言
// ============================================================================
//
// sessionActionSurfacesParity（源码正则 + 括号配对提取三面 case 标签）的泛化继任：
// 表化域的 action 集合可直接枚举（Object.keys(table.actions)），与 schema union 的
// 字面量集合（extractDomainActions 从 zod 提取）做集合相等——不再靠正则。
//
// 已表化域（session）另做三面对账：表 keys == schema == shellCapabilities 域集合
// （新 action 三处一起改）；web:false 暂缓棘轮刀 3 清零（断言无暂缓项）。
//
// 刀 4 追加全域单向门（见文件尾）：清单 ⊆ 实际 handler + 缺报棘轮，覆盖全部未表化域。
//
// 自举纪律（沿旧门教训）：提取 0 个 action → 报红（锚点失效不假绿）；
// 差集报错指名道姓一次列全（deny-list-by-name 教训）。
// ============================================================================
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { channelSchema } from '../../src/shared/ipc/schemas/core';
import { IPC_DOMAINS } from '../../src/shared/ipc/domains';
import {
  defineSessionRoutes,
  sessionRoutes,
} from '../../src/host/ipc/domainRoutes/sessionRoutes';
import { defineDomainRoutes, installDomainRoutes } from '../../src/host/ipc/domainRoutes/registry';
import { registerMemoryHandlers } from '../../src/host/ipc/memory.ipc';
import { registerDesktopHandlers } from '../../src/host/ipc/desktop.ipc';
import { registerTagHandlers } from '../../src/host/ipc/tag.ipc';
import { registerCronHandlers } from '../../src/host/ipc/cron.ipc';
import { registerPromptHandlers } from '../../src/host/ipc/prompt.ipc';
import { registerDiagnosticsHandlers } from '../../src/host/ipc/diagnostics.ipc';
import { getShellCapabilities } from '../../src/host/shellCapabilities';

// 结构枚举器挂既有函数对象上（knip 生产档无测试入口，独立 export 必成 dead export）
const { extractDomainActions } = installDomainRoutes;
const memoryRoutes = registerMemoryHandlers.routes;
const desktopRoutes = registerDesktopHandlers.routes;
const tagRoutes = registerTagHandlers.routes;
const cronRoutes = registerCronHandlers.routes;
const promptRoutes = registerPromptHandlers.routes;
const diagnosticsRoutes = registerDiagnosticsHandlers.routes;

/** 门盯的表清单——新域表化后加进来，门即自动覆盖该域（session 三面走 manifestDomain 断言） */
const ROUTE_TABLES = [
  { table: sessionRoutes, manifestDomain: 'domain:session' as const },
  { table: memoryRoutes, manifestDomain: 'domain:memory' as const },
  { table: desktopRoutes, manifestDomain: 'domain:desktop' as const },
  { table: tagRoutes, manifestDomain: 'domain:tag' as const },
  { table: cronRoutes, manifestDomain: 'domain:cron' as const },
  { table: promptRoutes, manifestDomain: 'domain:prompt' as const },
  { table: diagnosticsRoutes, manifestDomain: 'domain:diagnostics' as const },
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

  describe('domain:session web:false 暂缓棘轮（刀 3 清零）', () => {
    const webTable = defineSessionRoutes('web');

    it('无暂缓项：web 形态不带任何 web:false 标记（重新禁用需先改本门并说明理由）', () => {
      expect(
        webTable.disabledActions ?? [],
        'web:false 标记复活——刀 3 已把 5 个 desktop-only gap action 在 web 补齐，重新禁用必须先更新本断言并说明理由',
      ).toEqual([]);
    });

    it('web 形态与全量表逐 action 同实现（两侧差异只许沉入 context，不许按 surface 换 handler）', () => {
      const desktopHandlers = sessionRoutes.actions as Record<string, unknown>;
      const webHandlers = webTable.actions as Record<string, unknown>;
      const swapped = Object.keys(desktopHandlers).filter(
        (action) => desktopHandlers[action] !== webHandlers[action],
      );
      expect(
        swapped,
        `web 形态给这些 action 换了 handler：${swapped.join(', ')}——表必须单源，surface 差异沉入 SessionCommandContext`,
      ).toEqual([]);
    });
  });
});

// ============================================================================
// 全域单向门（RQ-183 刀 4）：清单 ⊆ 实际 handler + 缺报棘轮
// ============================================================================
//
// shellCapabilities 是壳兼容面（旧壳降级判定依赖）：允许策略性少报，禁止多报/瞎报
// （方案 2.4）。本门用源码提取枚举「实际 handler 的 action 集合」，钉三条：
//   ① IPC_DOMAINS 声明域 == 实际注册域（声明了零 handler = 新死域；提取塌了也在这里红）；
//   ② 清单 ⊆ 实际 handler（多报项修清单；整域 handler 缺席照报，不因域大而豁免）；
//   ③ 缺报棘轮：handler 有而清单无 ⊆ 基线，基线只减不增（止住方案 1.3 的继续腐烂：
//      新 action 不登记清单就过不了本门，补一个必须同步从基线删一行）。
//
// 提取认的形态（session 域除外——它走表结构枚举，是表化域的终态样本）：
//   - switch 的 case 标签（行首锚定，避免撞字符串/注释里的同名片段）；
//   - request?.action === 'x'（可选链、req/request/裸解构 action 三种 receiver）；
//   - request.action !== 'x'（否定式 fallthrough：不匹配则提前 return 未知错误，
//     命中后继续往下处理 = 该 action 被处理，如 voice 的 reportFailure）；
//   - defineHandler(XxxSchemas.REQUEST)（schema 化注册，channel 映射在
//     DEFINE_HANDLER_SCHEMA_CHANNEL——新增 schema 化域必须同步加映射，否则 ① 红）；
//   - provider 贡献式分发（HostProviderActionContribution 的 actions 数组，经
//     provider.ipc default 分支 dispatchHostProviderAction 分发，属性到 provider 域）。
// ============================================================================

/** 从 handle/defineHandler 调用点截取回调体：首个 => 后的第一个 { 起做括号配对 */
function extractHandlerBlock(source: string, anchorIdx: number, label: string): string {
  const arrowIdx = source.indexOf('=>', anchorIdx);
  expect(arrowIdx, `${label}: 找不到回调 =>——注册形态变了，更新本门提取器`).toBeGreaterThan(-1);
  const openBrace = source.indexOf('{', arrowIdx);
  expect(openBrace, `${label}: 找不到回调体 {——注册形态变了，更新本门提取器`).toBeGreaterThan(-1);
  let depth = 0;
  let end = -1;
  for (let i = openBrace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  expect(end, `${label}: 括号配对失败`).toBeGreaterThan(-1);
  return source.slice(openBrace, end);
}

const CASE_LABEL_RE = /^[ \t]*case '([^']+)':/gm;
// receiver 认 request/req（含可选链）与裸解构 action；负 lookbehind 排除
// args.action / value.action 这类「子对象自己的 action 字段」（它们不是域分发）
const ACTION_EQUALS_RE = /(?:\b(?:request|req)\??\.action|(?<![\w.?])action) === '([^']+)'/g;
const ACTION_NOT_EQUALS_RE = /(?:\b(?:request|req)\??\.action|(?<![\w.?])action) !== '([^']+)'/g;
const HANDLE_RE = /\b(?:ipcMain|ipcHost)\.handle\(\s*IPC_DOMAINS\.(\w+)/g;
const DEFINE_RE = /\bdefineHandler\(\s*(\w+)Schemas\.REQUEST/g;
/** schema 化注册的 channel 映射：新增 defineHandler 域必须同步登记（否则声明对账红） */
const DEFINE_HANDLER_SCHEMA_CHANNEL: Record<string, string> = {
  Admin: IPC_DOMAINS.ADMIN,
  QueuedInput: IPC_DOMAINS.QUEUED_INPUT,
  BackgroundTask: IPC_DOMAINS.BACKGROUND_TASKS,
};

function collectBlockActions(block: string): Set<string> {
  const actions = new Set<string>();
  for (const m of block.matchAll(CASE_LABEL_RE)) actions.add(m[1]);
  for (const m of block.matchAll(ACTION_EQUALS_RE)) actions.add(m[1]);
  for (const m of block.matchAll(ACTION_NOT_EQUALS_RE)) actions.add(m[1]);
  return actions;
}

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listTsFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 实际 handler 侧的域 → action 集合（源码提取 + session 表结构枚举） */
function collectActualDomainActions(): Map<string, Set<string>> {
  const domainKeyToChannel = new Map<string, string>(
    Object.entries(IPC_DOMAINS).map(([key, channel]) => [key, channel]),
  );
  const actual = new Map<string, Set<string>>();
  const add = (channel: string, actions: Set<string>): void => {
    const cur = actual.get(channel) ?? new Set<string>();
    for (const action of actions) cur.add(action);
    actual.set(channel, cur);
  };

  const providerContributed = new Set<string>();
  for (const file of listTsFiles(path.join(process.cwd(), 'src/host'))) {
    const source = fs.readFileSync(file, 'utf-8');
    for (const m of source.matchAll(HANDLE_RE)) {
      const channel = domainKeyToChannel.get(m[1]);
      if (!channel) continue;
      add(channel, collectBlockActions(extractHandlerBlock(source, m.index!, `${file}:${m[1]}`)));
    }
    for (const m of source.matchAll(DEFINE_RE)) {
      const channel = DEFINE_HANDLER_SCHEMA_CHANNEL[m[1]];
      if (!channel) continue;
      add(channel, collectBlockActions(extractHandlerBlock(source, m.index!, `${file}:${m[1]}`)));
    }
    // provider 贡献式分发：actions: <IDENT> 指向同文件 const IDENT = ['...', ...]
    if (source.includes('HostProviderActionContribution')) {
      const constArrays = new Map<string, string[]>();
      for (const m of source.matchAll(/const (\w+) = \[([^\]]*)\]/g)) {
        const literals = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
        if (literals.length) constArrays.set(m[1], literals);
      }
      for (const m of source.matchAll(/\bactions:\s*(\w+)\s*,/g)) {
        const arr = constArrays.get(m[1]);
        if (arr) for (const action of arr) providerContributed.add(action);
      }
    }
  }
  add(IPC_DOMAINS.PROVIDER, providerContributed);
  // session 域：单源路由表结构枚举（表化域不走源码提取）
  add(IPC_DOMAINS.SESSION, new Set(Object.keys(sessionRoutes.actions)));
  add(IPC_DOMAINS.MEMORY, new Set(Object.keys(memoryRoutes.actions)));
  add(IPC_DOMAINS.DESKTOP, new Set(Object.keys(desktopRoutes.actions)));
  add(IPC_DOMAINS.TAG, new Set(Object.keys(tagRoutes.actions)));
  add(IPC_DOMAINS.CRON, new Set(Object.keys(cronRoutes.actions)));
  add(IPC_DOMAINS.PROMPT, new Set(Object.keys(promptRoutes.actions)));
  add(IPC_DOMAINS.DIAGNOSTICS, new Set(Object.keys(diagnosticsRoutes.actions)));
  return actual;
}

/**
 * 缺报棘轮基线（2026-09-15 建门实测，21 域 116 项）：handler 有而清单无的存量项。
 * 清单是壳兼容面、允许策略性少报——但少报集合冻结在此、只减不增：
 * 把某 action 补进 CAPABILITY_DOMAIN_ACTIONS 后必须同步从基线删掉它；
 * 新增 handler action 不登记清单 = 新缺报 = 红，要么补清单要么显式扩基线（PR 里说明理由）。
 */
const KNOWN_UNDER_REPORTED_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  'domain:backgroundTasks': ['drainNotifications', 'getTask', 'listTasks', 'markNotificationDelivered', 'readTaskLog'],
  'domain:data': ['cacheCleanExpired', 'cacheClear', 'cacheGetStats'],
  'domain:device': ['list', 'register', 'remove'],
  'domain:folderTrust': ['revoke'],
  'domain:generativeUI': ['capabilities'],
  'domain:hook': ['setEnabled'],
  'domain:loop': ['get', 'list', 'start', 'stop'],
  'domain:project': ['redeemInvite', 'revokeInvite'],
  'domain:provider': ['delete_realtime_voice_provider'],
  'domain:surfaceExecution': ['startLiveStream', 'stopLiveStream'],
  'domain:sync': ['resolveConflict'],
  'domain:task': ['cancelBackgroundTask'],
  'domain:voice': ['injectUserText'],
  'domain:window': ['close', 'maximize', 'minimize'],
  'domain:workspace': ['closeLinkInRail', 'controlUserBrowserHistory', 'dispatchUserBrowserInput', 'openExternal', 'openLinkInRail', 'setUserBrowserViewport'],};

describe('全域单向门：清单 ⊆ 实际 handler（RQ-183 刀 4）', () => {
  const actual = collectActualDomainActions();
  const manifestByDomain = new Map<string, Set<string>>();
  for (const capability of getShellCapabilities()) {
    if (capability.layer !== 'domain') continue;
    const cur = manifestByDomain.get(capability.domain) ?? new Set<string>();
    cur.add(capability.action);
    manifestByDomain.set(capability.domain, cur);
  }

  it('自举：IPC_DOMAINS 声明域 == 实际注册域（声明零 handler = 新死域；提取塌了也在这里红）', () => {
    const declared = new Set<string>(Object.values(IPC_DOMAINS));
    const problems = [
      ...[...declared].filter((d) => !actual.has(d) || (actual.get(d)?.size ?? 0) === 0)
        .map((d) => `  ${d} → 声明了但零 handler（死域，或提取器没认出新注册形态）`),
      ...[...actual.keys()].filter((d) => !declared.has(d))
        .map((d) => `  ${d} → 注册了但未在 IPC_DOMAINS 声明`),
    ];
    expect(
      problems,
      `IPC_DOMAINS 与实际注册域不一致：\n${problems.join('\n')}`,
    ).toEqual([]);
  });

  it('单向：清单 ⊆ 实际 handler（多报/瞎报禁止；整域 handler 缺席照报）', () => {
    const problems: string[] = [];
    for (const [domain, manifestActions] of [...manifestByDomain.entries()].sort()) {
      const actualActions = actual.get(domain);
      if (!actualActions) {
        problems.push(`  ${domain} → 整域无 handler（死域），清单却登记了 ${manifestActions.size} 项`);
        continue;
      }
      for (const action of [...manifestActions].sort()) {
        if (!actualActions.has(action)) problems.push(`  ${domain}/${action}`);
      }
    }
    expect(
      problems,
      `清单里这些项在实际 handler 中不存在（多报/瞎报，修 CAPABILITY_DOMAIN_ACTIONS）：\n${problems.join('\n')}`,
    ).toEqual([]);
  });

  it('缺报棘轮：handler 有而清单无 ⊆ 基线，基线只减不增', () => {
    const problems: string[] = [];
    // 新缺报：不在基线里的少报项
    for (const [domain, actualActions] of [...actual.entries()].sort()) {
      const manifestActions = manifestByDomain.get(domain) ?? new Set<string>();
      const allowed = new Set(KNOWN_UNDER_REPORTED_ACTIONS[domain] ?? []);
      for (const action of [...actualActions].sort()) {
        if (!manifestActions.has(action) && !allowed.has(action)) {
          problems.push(`  ${domain}/${action} → 新缺报：补进清单，或显式扩基线并说明理由`);
        }
      }
    }
    // 基线过期：已补进清单 / handler 已不存在的基线项
    for (const [domain, actions] of Object.entries(KNOWN_UNDER_REPORTED_ACTIONS)) {
      const actualActions = actual.get(domain) ?? new Set<string>();
      const manifestActions = manifestByDomain.get(domain) ?? new Set<string>();
      for (const action of actions) {
        if (manifestActions.has(action)) {
          problems.push(`  ${domain}/${action} → 已补进清单，从基线删掉它`);
        } else if (!actualActions.has(action)) {
          problems.push(`  ${domain}/${action} → handler 已不存在，从基线删掉它`);
        }
      }
    }
    expect(
      problems,
      `缺报棘轮被破：\n${problems.join('\n')}`,
    ).toEqual([]);
  });
});
