// ============================================================================
// 死主进程路径的防复发门
//
// src/host/index.ts 这条 Electron main 路径不在任何发行版中执行，但它的文件名
// （"Main Process Entry" / "Background Services"）看起来正是该挂后台服务的地方。
// 挂错不报错、不红任何测试，只是永远不执行——webServer.ts :515/:617/:653 三处注释
// 就是三次补课记录，dbRetention/logRetention 是第四次（生产库因此涨到 377MB+）。
//
// 这道门钉三件事：
//   1. 仍保留的两个死文件，其 DEAD PATH 标记不许被静默删掉；
//   2. 标记所声称的事实仍然成立——src/host/index.ts 确实不是 esbuild 入口。
//      若哪天真把它接回构建，本门会红，逼人来处理标记而不是留下自相矛盾的注释。
//   3. initBackgroundServices.ts 必须物理消失，迁出的注册必须经 webServer →
//      webStartupServices 两跳进入发行版。
// 外加：dbRetention / logRetention 与 Light Memory 的既有 web 接线不许再掉。
//
// 新增断言守住本轮已知 registrar 的名字与两跳调用，不声称能自动识别未来换名的新服务；
// 未来新增启动服务若使用全新符号，仍需 code review 判断它是否属于后台注册面。
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

const DEAD_PATH_FILES = [
  'src/host/index.ts',
  'src/host/app/bootstrap.ts',
];

const MAIN_PROCESS_ENTRY = 'src/host/index.ts';
const SHIPPED_ENTRY = 'src/web/webServer.ts';
const RETENTION_KICKOFF = 'src/web/webStartupRetention.ts';
const STARTUP_SERVICES = 'src/web/webStartupServices.ts';
const REMOVED_BACKGROUND_ENTRY = 'src/host/app/initBackgroundServices.ts';
const HOST_APP_DIR = 'src/host/app';
const MIGRATED_REGISTRATIONS: Array<[string, RegExp]> = [
  ['预算 hydrate + alert', /budget:\s*\(\)\s*=>\s*\{\s*wireBudgetService\s*\(/],
  ['EventBus → SSE bridge', /\binitWebEventBridge\s*\(/],
  ['ComboRecorder', /\bgetComboRecorder\s*\(\s*\)\.init\s*\(/],
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
  it.each(DEAD_PATH_FILES)('%s 保留 DEAD PATH 标记与正确的改挂指引', (file) => {
    const source = read(file);
    expect(source, `${file} 的 DEAD PATH 标记被删了。它不是装饰：没有它，下一个人会把新的后台服务挂进这条永不执行的路径。`)
      .toContain('DEAD PATH');
    expect(source, `${file} 的标记里必须指明改挂 ${SHIPPED_ENTRY}，否则读者知道这里是死的也不知道该去哪。`)
      .toContain(SHIPPED_ENTRY);
  });

  it('src/host/index.ts 仍然不是任何 esbuild 构建入口（标记所声称的事实）', () => {
    const config = readCode('esbuild.config.ts');
    const entries = [...config.matchAll(/entry:\s*'([^']+)'/g)].map((m) => m[1]);

    // 自检：解析没解出东西就该红，而不是"零命中=通过"地假绿
    expect(entries.length, 'esbuild.config.ts 里一个 entry 都没解析到，说明本门的解析口径已失效，需要修门而不是放行').toBeGreaterThan(0);
    expect(entries).toContain(SHIPPED_ENTRY);

    expect(entries, `${MAIN_PROCESS_ENTRY} 被接回构建入口了，现存两个文件的 DEAD PATH 标记就成了错的，请同步处理。`)
      .not.toContain(MAIN_PROCESS_ENTRY);
  });

  it('initBackgroundServices.ts 不许在 src/host/app 下复活', () => {
    expect(
      existsSync(path.join(root, REMOVED_BACKGROUND_ENTRY)),
      '死入口已被抽干并删除；恢复同名文件会重新制造一个看似正确、发行版却永不执行的挂载点',
    ).toBe(false);
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
