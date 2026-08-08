/**
 * T1 · 更新流程优雅停机的静态契约门。
 *
 * 背景：Windows 上 tauri-plugin-updater 的 install 在 crate 内部 ShellExecuteW 拉起
 * NSIS 之后直接 `std::process::exit(0)`，控制流永不返回——`RunEvent::Exit` 不会来，
 * `cleanup_server` 一次都不跑，webServer 被硬杀，留下陈旧 -wal/-shm（2026-08-07 Windows
 * 真机实测坐实）。修复分三处：① `terminate_child` 的 not(unix) 分支改走 stdin-EOF
 * 优雅路径 ② 渲染器在 install 之前显式 invoke 一个新命令优雅停 webServer
 * ③ Node 侧 shutdown() 给关库前的清理步骤加超时护栏。
 *
 * 这三处里最脆的是「Rust 关 stdin + Node 监听 EOF」这一纸跨端合同：任何一端被删，
 * Windows 静默退回硬杀，且没有任何测试会红（本地/CI 都在 mac/Linux 上跑，这条通路
 * 从不会被 hermetic/real-runtime 档触发）。所以本门必须同时钉两端。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const readTauri = (rel: string) => fs.readFileSync(path.join(root, 'src-tauri', rel), 'utf8');
const readSrc = (rel: string) => fs.readFileSync(path.join(root, 'src', rel), 'utf8');

describe('T1 更新流程优雅停机', () => {
  it('unix 与 not(unix) 的 terminate_child 都收敛到共用的 wait_then_force_kill', () => {
    const main = readTauri('src/main.rs');

    expect(main).toContain('fn wait_then_force_kill(child: &mut Child, graceful_reason: &str)');
    // 两个 terminate_child 定义体内都要调用它，锚在调用行本身，别被注释文本命中
    const unixBlock = /#\[cfg\(unix\)\]\s*fn terminate_child[\s\S]*?\n\}/.exec(main);
    const notUnixBlock = /#\[cfg\(not\(unix\)\)\]\s*fn terminate_child[\s\S]*?\n\}/.exec(main);
    expect(unixBlock, 'unix 分支的 terminate_child 锚点失效').not.toBeNull();
    expect(notUnixBlock, 'not(unix) 分支的 terminate_child 锚点失效').not.toBeNull();
    expect(unixBlock![0]).toMatch(/wait_then_force_kill\(child,/);
    expect(notUnixBlock![0]).toMatch(/wait_then_force_kill\(child,/);
  });

  it('Windows 分支改走 stdin-EOF 优雅路径，不再是无条件强杀', () => {
    const main = readTauri('src/main.rs');
    const notUnixBlock = /#\[cfg\(not\(unix\)\)\]\s*fn terminate_child[\s\S]*?\n\}/.exec(main);
    expect(notUnixBlock, 'not(unix) 分支的 terminate_child 锚点失效').not.toBeNull();

    expect(notUnixBlock![0]).toContain('child.stdin.take()');
    // 旧的无条件强杀理由必须已被替换，防止「加了新函数但没接上」的假修复
    expect(main).not.toContain('forced-sigkill-no-signal-support');
  });

  it('新命令 shutdown_web_server_for_update 存在且调用 cleanup_server', () => {
    const main = readTauri('src/main.rs');

    const fnBlock = /fn shutdown_web_server_for_update\(app: tauri::AppHandle\)\s*\{[\s\S]*?\n\}/.exec(
      main
    );
    expect(fnBlock, 'shutdown_web_server_for_update 函数体锚点失效').not.toBeNull();
    expect(fnBlock![0]).toContain('cleanup_server(&app)');

    // generate_handler! 注册和 ACL 白名单必须同步，否则打包态静默不可用
    // （对账门 tests/scripts/tauriCommandAcl.test.ts 也会验，这里从「新命令」角度补一道）
    const handlerBlock = /generate_handler!\[([\s\S]*?)\]\)/.exec(main);
    expect(handlerBlock, 'generate_handler![...] 锚点失效').not.toBeNull();
    expect(handlerBlock![1]).toMatch(/\bshutdown_web_server_for_update\b/);

    const acl = readTauri('permissions/app-commands.toml');
    expect(acl).toMatch(/"shutdown_web_server_for_update"/);
  });

  it('渲染器按 download → shutdown_web_server_for_update → install 的顺序调用', () => {
    const updater = readSrc('renderer/utils/tauriUpdater.ts');

    const downloadIdx = updater.indexOf('await update.download(');
    const invokeIdx = updater.indexOf("invoke('shutdown_web_server_for_update')");
    const installIdx = updater.indexOf('await update.install()');

    expect(downloadIdx, 'update.download( 调用点缺失').toBeGreaterThan(-1);
    expect(invokeIdx, "invoke('shutdown_web_server_for_update') 调用点缺失").toBeGreaterThan(-1);
    expect(installIdx, 'update.install() 调用点缺失').toBeGreaterThan(-1);
    expect(downloadIdx).toBeLessThan(invokeIdx);
    expect(invokeIdx).toBeLessThan(installIdx);

    // 旧的一体化调用必须已被拆开，防止两条路径并存导致 Windows 仍走老序列。
    // 锚在实际调用语法上，别被解释「为什么拆开」的注释文本（提到 downloadAndInstall
    // 这个名字）撞上。
    expect(updater).not.toContain('update.downloadAndInstall(');
  });

  it('capability 已从 download-and-install 换成拆开的 download + install 两条权限', () => {
    const capability = JSON.parse(readTauri('capabilities/default.json'));

    expect(capability.permissions).toContain('updater:allow-download');
    expect(capability.permissions).toContain('updater:allow-install');
    expect(capability.permissions).not.toContain('updater:allow-download-and-install');
  });

  it('跨端合同没有被单边削掉：Rust 关 stdin 写端 + Node 监听 stdin EOF 必须同时存在', () => {
    const main = readTauri('src/main.rs');
    const webServer = readSrc('web/webServer.ts');

    // Rust 侧：spawn 时用 piped stdin，才有「关写端 = 子进程收到 EOF」这回事
    expect(main).toContain('.stdin(Stdio::piped())');

    // Node 侧：必须仍然监听 stdin 的 'end' 事件并挂在 Tauri boot token 守卫之下，
    // 这条通路只在被 Tauri spawn 时生效（standalone/dev 模式没有这个环境变量）
    const guardBlock = /if \(process\.env\.CODE_AGENT_TAURI_BOOT_TOKEN\)\s*\{[\s\S]*?\n\s*\}/.exec(
      webServer
    );
    expect(guardBlock, 'CODE_AGENT_TAURI_BOOT_TOKEN 守卫块锚点失效').not.toBeNull();
    expect(guardBlock![0]).toContain("process.stdin.on('end'");
  });
});
