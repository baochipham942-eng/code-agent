// ============================================================================
// 死主进程路径的防复发门
//
// src/host/index.ts 这条 Electron main 路径不在任何发行版中执行，但它的文件名
// （"Main Process Entry" / "Background Services"）看起来正是该挂后台服务的地方。
// 挂错不报错、不红任何测试，只是永远不执行——webServer.ts :515/:617/:653 三处注释
// 就是三次补课记录，dbRetention/logRetention 是第四次（生产库因此涨到 377MB+）。
//
// 这道门钉两件事：
//   1. 三个文件的 DEAD PATH 标记不许被静默删掉（重构时最容易顺手抹掉）；
//   2. 标记所声称的事实仍然成立——src/host/index.ts 确实不是 esbuild 入口。
//      若哪天真把它接回构建，本门会红，逼人来处理标记而不是留下自相矛盾的注释。
// 外加 3：dbRetention / logRetention 在 webServer 里的接线不许再掉。
// ============================================================================
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string): string => readFileSync(path.join(root, file), 'utf8');

const DEAD_PATH_FILES = [
  'src/host/index.ts',
  'src/host/app/bootstrap.ts',
  'src/host/app/initBackgroundServices.ts',
];

const MAIN_PROCESS_ENTRY = 'src/host/index.ts';
const SHIPPED_ENTRY = 'src/web/webServer.ts';
const RETENTION_KICKOFF = 'src/web/webStartupRetention.ts';

describe('死主进程路径（src/host/index.ts）', () => {
  it.each(DEAD_PATH_FILES)('%s 保留 DEAD PATH 标记与正确的改挂指引', (file) => {
    const source = read(file);
    expect(source, `${file} 的 DEAD PATH 标记被删了。它不是装饰：没有它，下一个人会把新的后台服务挂进这条永不执行的路径。`)
      .toContain('DEAD PATH');
    expect(source, `${file} 的标记里必须指明改挂 ${SHIPPED_ENTRY}，否则读者知道这里是死的也不知道该去哪。`)
      .toContain(SHIPPED_ENTRY);
  });

  it('src/host/index.ts 仍然不是任何 esbuild 构建入口（标记所声称的事实）', () => {
    const config = read('esbuild.config.ts');
    const entries = [...config.matchAll(/entry:\s*'([^']+)'/g)].map((m) => m[1]);

    // 自检：解析没解出东西就该红，而不是"零命中=通过"地假绿
    expect(entries.length, 'esbuild.config.ts 里一个 entry 都没解析到，说明本门的解析口径已失效，需要修门而不是放行').toBeGreaterThan(0);
    expect(entries).toContain(SHIPPED_ENTRY);

    expect(entries, `${MAIN_PROCESS_ENTRY} 被接回构建入口了 —— 那三个文件的 DEAD PATH 标记就成了错的，请同步处理。`)
      .not.toContain(MAIN_PROCESS_ENTRY);
  });

  // 接线是两跳（webServer → webStartupRetention → 两个 retention 模块），两跳都要钉，
  // 断掉任一跳清理都不会执行。
  // 断言用带词边界的「模块路径 + 调用」双要素，不用 toContain：子串匹配会被
  // runDbRetention_MUTANT 这类改名骗过去（本门首版实测就是这么假绿的）。
  it('webServer.ts 真的调了启动期保留清理（第一跳）', () => {
    const webServer = read(SHIPPED_ENTRY);
    expect(webServer, 'webServer 未 import webStartupRetention：启动期清理不会执行')
      .toMatch(/from\s+'\.\/webStartupRetention'/);
    expect(webServer, 'webServer 未调用 kickoffStartupRetention()：import 了但没调等于没接')
      .toMatch(/\bkickoffStartupRetention\s*\(\s*\)/);
  });

  it.each([
    ['logRetention', /\brunLogRetention\s*\(/, '审计日志清理在发行版里不会执行'],
    ['dbRetention', /\brunDbRetention\s*\(/, 'telemetry 表无 TTL，生产库会无限涨（实测 377MB+）'],
  ])('webStartupRetention.ts 真的调了 %s（第二跳）', (moduleName, callPattern, consequence) => {
    const kickoff = read(RETENTION_KICKOFF);
    expect(kickoff, `未 import ${moduleName}：${consequence}`)
      .toMatch(new RegExp(`services/infra/${moduleName}['"]`));
    expect(kickoff, `未调用 ${moduleName} 的入口函数：${consequence}`)
      .toMatch(callPattern);
  });
});
