// ============================================================================
// 死主进程路径的防复发门
//
// src/host/index.ts → src/host/app/bootstrap.ts 这条 Electron main 路径已经物理删除。
// 它从未进入任何发行版，但文件名（"Main Process Entry" / "Background Services"）
// 看起来正是该挂后台服务的地方。挂错不报错、不红任何测试，只是永远不执行——
// webServer.ts :515/:617/:653 三处注释是前三次补课记录，dbRetention/logRetention
// 是第四次（生产库因此涨到 377MB+）。
//
// 这道门钉三件事：
//   1. 三个误导性死入口不许以同名文件复活；
//   2. src/host/index.ts 不许重新混入 esbuild 入口；
//   3. 迁出的注册必须经 webServer →
//      webStartupServices 两跳进入发行版。
// 外加：dbRetention / logRetention 与 Light Memory 的既有 web 接线不许再掉。
//
// 已知盲区（继续如实记录）：本门守住本轮已知 registrar 的名字与两跳调用，无法自动
// 识别未来换名的新服务。未来新增启动服务若使用全新符号，仍需 code review 判断它是否
// 属于后台注册面、是否放在 src/web 的启动文件。它也不解析 JS AST，下面的按行去注释
// 只能覆盖已经实际发生过的两类失效形态。
// ============================================================================
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string): string => readFileSync(path.join(root, file), 'utf8');

/**
 * 代码类断言必须排除注释行再匹配。
 * 本门被自己的变异验证抓到两次假绿，都是这条的变体：
 *   1) toContain('runDbRetention') 被改名 runDbRetention_MUTANT 骗过（子串匹配）；
 *   2) 正则匹配到 `// kickoffStartupRetention();` 这行被注释掉的调用。
 *
 * 实现刻意保持"按行丢弃"而不是解析块注释：正则版 /\/\*[\s\S]*?\*\// 会把源码里
 * '**\/*.ts' 这类 glob 字符串当成块注释起点，一路吃掉后面的真代码（实测把本门
 * 自己弄红了）。
 *
 * 已知盲区（如实记下，不假装覆盖）：写成 `\/* kickoff(); *\/` 的块注释形态骗得过
 * 本函数。取舍理由是真实的失效形态是整行注释掉或删掉，为覆盖块注释去写一个
 * 半吊子 JS 解析器不划算。
 */
function dropCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}
const readCode = (file: string): string => dropCommentLines(read(file));

const REMOVED_DEAD_ENTRY_FILES = [
  'src/host/index.ts',
  'src/host/app/bootstrap.ts',
  'src/host/app/initBackgroundServices.ts',
];

const MAIN_PROCESS_ENTRY = 'src/host/index.ts';
const SHIPPED_ENTRY = 'src/web/webServer.ts';
const RETENTION_KICKOFF = 'src/web/webStartupRetention.ts';
const STARTUP_SERVICES = 'src/web/webStartupServices.ts';
const HOST_APP_DIR = 'src/host/app';
const MIGRATED_REGISTRATIONS: Array<[string, RegExp]> = [
  ['预算 hydrate + alert', /budget:\s*\(\)\s*=>\s*\{\s*wireBudgetService\s*\(/],
  ['EventBus → SSE bridge', /\binitWebEventBridge\s*\(/],
  // ComboRecorder 那行已随 N-CAP1（#1140）删除：它的 init() 订阅的 EventBus 事件主链路根本
  // 不发，是死代码；真正的记账接线在 AgentLoop（所有入口的唯一汇聚点），由下面单独一条钉住。
  ['候选能力账本预热', /\bgetCapabilityCandidateStore\s*\(\s*\)\.load\s*\(/],
  ['DAG event bridge', /\binitDAGEventBridge\s*\(/],
  ['DAG resolver', /\.setAgentResolver\s*\(/],
  ['/dream executor', /\bregisterDreamSkillExecutor\s*\(/],
  ['/distill executor', /\bregisterDistillSkillExecutor\s*\(/],
  ['HeartbeatService', /\binitHeartbeatService\s*\(/],
  ['HEARTBEAT.md loader', /\bnew\s+HeartbeatTaskLoader\s*\(/],
  ['PostHog identity', /posthogIdentity:\s*async\s*\(\)\s*=>\s*\{[\s\S]*?\bwirePostHogIdentity\s*\(/],
  ['LogBridge command handler', /\.setCommandHandler\s*\(/],
  ['file checkpoint cleanup', /\bgetFileCheckpointService\s*\(\s*\)\.cleanup\s*\(/],
  ['debug snapshot cleanup', /\bclearCompactionSnapshots\s*\(/],
  ['OpenChronicle reconcile', /\binitOpenchronicle\s*\(/],
  ['SOUL/PROFILE watcher', /\bwatchSoulFiles\s*\(/],
  ['model consistency', /\bvalidateModelConsistency\s*\(/],
];

describe('死主进程路径（src/host/index.ts）', () => {
  it.each(REMOVED_DEAD_ENTRY_FILES)('%s 不许以任何形式复活', (file) => {
    expect(
      existsSync(path.join(root, file)),
      `${file} 是已删除的误导性死入口；后台服务注册只能放在 src/web 的发行版启动文件`,
    ).toBe(false);
  });

  it('发行版 esbuild 入口包含 webServer，且不含 src/host/index.ts', () => {
    const config = readCode('esbuild.config.ts');
    const entries = [...config.matchAll(/entry:\s*'([^']+)'/g)].map((m) => m[1]);

    // 自检：解析没解出东西就该红，而不是"零命中=通过"地假绿
    expect(entries.length, 'esbuild.config.ts 里一个 entry 都没解析到，说明本门的解析口径已失效，需要修门而不是放行').toBeGreaterThan(0);
    expect(entries).toContain(SHIPPED_ENTRY);

    expect(entries, `${MAIN_PROCESS_ENTRY} 被接回构建入口了；这会恢复已确认不属于发行版的旧主进程路径。`)
      .not.toContain(MAIN_PROCESS_ENTRY);
  });

  it('webServer 真的调用集中式发行版后台启动入口（第一跳）', () => {
    const webServer = readCode(SHIPPED_ENTRY);
    expect(webServer, 'webServer 未 import webStartupServices：迁出的后台服务不会执行')
      .toMatch(/from\s+'\.\/webStartupServices'/);
    expect(webServer, 'webServer 未调用 kickoffWebStartupServices()：import 了仍等于没接')
      .toMatch(/\bkickoffWebStartupServices\s*\(/);
  });

  it.each(MIGRATED_REGISTRATIONS)('%s 的注册落在 src/web 启动文件（第二跳）', (_capability, callPattern) => {
    expect(readCode(STARTUP_SERVICES)).toMatch(callPattern);
  });

  // ComboRecorder 不在启动文件里注册：桌面真机入口 /api/run 走 cli/bootstrap.createAgentLoop，
  // 不经 AgentOrchestrator（2026-08-14 N-CAP1 真机实测），所以记账只能接在 AgentLoop 这个
  // 所有入口的汇聚点上。原先钉 src/web 的 init() 锚点已随 #1140 删掉那段死代码而失效。
  it('ComboRecorder 的每轮记账接在 AgentLoop 上', () => {
    const agentLoop = readCode('src/host/agent/agentLoop.ts');
    expect(agentLoop, 'AgentLoop 未按工具执行日志记账：候选能力探测会拿不到任何一步')
      .toMatch(/\bgetComboRecorder\s*\(\s*\)\.recordStep\s*\(/);
    expect(agentLoop, 'AgentLoop 未标记轮次：记账缺少轮边界，组合签名会跨轮串味')
      .toMatch(/\bmarkTurn\s*\(/);
  });

  it('同批后台 registrar 不得残留或重新挂进 src/host/app', () => {
    const hostAppCode = readdirSync(path.join(root, HOST_APP_DIR))
      .filter((file) => file.endsWith('.ts'))
      .map((file) => readCode(path.join(HOST_APP_DIR, file)))
      .join('\n');

    for (const [capability, callPattern] of MIGRATED_REGISTRATIONS) {
      expect(
        hostAppCode,
        `${capability} 又出现在 src/host/app；该目录不在发行版启动链，注册必须留在 src/web 启动文件`,
      ).not.toMatch(callPattern);
    }
  });

  // 接线是两跳（webServer → webStartupRetention → 两个 retention 模块），两跳都要钉，
  // 断掉任一跳清理都不会执行。
  // 断言用带词边界的「模块路径 + 调用」双要素，不用 toContain：子串匹配会被
  // runDbRetention_MUTANT 这类改名骗过去（本门首版实测就是这么假绿的）。
  it('webServer.ts 真的调了启动期保留清理（第一跳）', () => {
    const webServer = readCode(SHIPPED_ENTRY);
    expect(webServer, 'webServer 未 import webStartupRetention：启动期清理不会执行')
      .toMatch(/from\s+'\.\/webStartupRetention'/);
    expect(webServer, 'webServer 未调用 kickoffStartupRetention()：import 了但没调等于没接')
      .toMatch(/\bkickoffStartupRetention\s*\(\s*\)/);
  });

  it.each([
    ['logRetention', /\brunLogRetention\s*\(/, '审计日志清理在发行版里不会执行'],
    ['dbRetention', /\brunDbRetention\s*\(/, 'telemetry 表无 TTL，生产库会无限涨（实测 377MB+）'],
  ])('webStartupRetention.ts 真的调了 %s（第二跳）', (moduleName, callPattern, consequence) => {
    const kickoff = readCode(RETENTION_KICKOFF);
    expect(kickoff, `未 import ${moduleName}：${consequence}`)
      .toMatch(new RegExp(`services/infra/${moduleName}['"]`));
    expect(kickoff, `未调用 ${moduleName} 的入口函数：${consequence}`)
      .toMatch(callPattern);
  });

  it('webServer.ts 真的注册了 Light Memory 整理 job', () => {
    const webServer = readCode(SHIPPED_ENTRY);
    expect(webServer, 'webServer 未 import webStartupMemoryJobs：记忆整理 job 在发行版里不会被创建')
      .toMatch(/from\s+'\.\/webStartupMemoryJobs'/);
    expect(webServer, 'webServer 未调用 registerMemoryConsolidationJob()：记忆只写不整理')
      .toMatch(/\bregisterMemoryConsolidationJob\s*\(\s*\)/);
  });

  // dream / distill 是**有意**不接线（会无人值守自动花钱，属产品+成本判断）。
  // 钉住这个"有意"：标记若被抹掉，下一个人会把它当成遗漏顺手接上，于是在用户不知情的
  // 情况下开始烧钱。这是本门里唯一一条"防止别人把东西接上"的断言。
  it.each([
    'src/host/services/memory/dreamScheduler.ts',
    'src/host/services/skills/distillScheduler.ts',
  ])('%s 保留「有意未接线」标记', (file) => {
    const source = read(file);
    expect(source, `${file} 的「有意未接线」标记被删了。没有它，下一个人会把它当遗漏接上，导致无人值守的付费 LLM 调用。`)
      .toContain('有意未接线');
  });

  it('dream / distill cron 仍未迁入发行版启动文件', () => {
    const startup = readCode(STARTUP_SERVICES);
    expect(startup).not.toMatch(/\bsyncDreamCronJob\s*\(/);
    expect(startup).not.toMatch(/\bsyncDistillCronJob\s*\(/);
  });

  it('云同步保留「有意未接线」隐私标记，发行版启动链不自动上传对话正文', () => {
    const syncService = read('src/host/services/sync/syncService.ts');
    const startup = readCode(STARTUP_SERVICES);
    expect(syncService).toContain('有意未接线');
    expect(syncService).toContain('完整对话正文');
    expect(startup).not.toMatch(/\bstartAutoSync\s*\(/);
  });
});
