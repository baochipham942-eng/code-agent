/**
 * Tauri app 自定义命令的 ACL 对账门。
 *
 * 渲染器从 remote origin(本地 webServer)加载，Tauri 2 对 remote 上下文的 app 命令默认全拒；
 * 且 `src-tauri/permissions/` 一旦存在，本地上下文的 app 命令也开始被 ACL 检查。
 * 于是「在 generate_handler! 里注册」和「在 permissions 里授权」成了两个必须同步的枚举点，
 * 漏掉一边的后果是**打包态静默不可用**（desktop_start_voice_aec 已经这么死过三个月）。
 *
 * 本门把两处枚举点对账，任一侧新增/删除而另一侧没跟上就报红。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const readTauri = (rel: string) => fs.readFileSync(path.join(root, 'src-tauri', rel), 'utf8');

/** `generate_handler![...]` 里注册的命令名 */
function registeredCommands(): string[] {
  const main = readTauri('src/main.rs');
  const block = /generate_handler!\[([\s\S]*?)\]\)/.exec(main);
  expect(block, 'main.rs 里找不到 generate_handler![...]，锚点失效').not.toBeNull();
  return block![1]
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => /^[a-z][a-z0-9_]*$/.test(entry));
}

/** `permissions/*.toml` 里 commands.allow 授权的命令名（跨文件取并集） */
function authorizedCommands(): string[] {
  const dir = path.join(root, 'src-tauri/permissions');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.toml'));
  expect(files.length, 'src-tauri/permissions 下没有 toml，app 命令 ACL 授权缺失').toBeGreaterThan(0);
  const allowed: string[] = [];
  for (const file of files) {
    const toml = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const list of toml.matchAll(/commands\.allow\s*=\s*\[([\s\S]*?)\]/g)) {
      for (const quoted of list[1].matchAll(/"([a-z][a-z0-9_]*)"/g)) allowed.push(quoted[1]);
    }
  }
  return allowed;
}

describe('Tauri app command ACL', () => {
  it('每条注册的命令都恰好被授权一次', () => {
    const registered = registeredCommands();
    const authorized = authorizedCommands();

    // 锚点自检：正则失效时上面两个解析都会静默返回空数组，这里让门自己报红而不是假绿
    expect(registered.length).toBeGreaterThan(30);
    expect(authorized.length).toBeGreaterThan(30);

    expect(new Set(authorized).size, `permissions 里有重复授权: ${authorized.join(', ')}`).toBe(
      authorized.length
    );
    expect([...authorized].sort()).toEqual([...registered].sort());
  });

  it('主窗 capability 把命令授给两个本地 webServer origin', () => {
    const capability = JSON.parse(readTauri('capabilities/default.json'));

    expect(capability.windows).toContain('main');
    expect(capability.permissions).toContain('allow-renderer-commands');
    // 生产包 8180 / Dev 包 8181，少一个就是那个通道的命令全死
    expect(capability.remote.urls).toEqual(
      expect.arrayContaining(['http://localhost:8180/*', 'http://localhost:8181/*'])
    );
  });

  it('PiP 窗只拿 pip_control，且不授任何 remote 上下文', () => {
    const capability = JSON.parse(readTauri('capabilities/pip.json'));
    const pip = readTauri('src/pip.rs');

    expect(pip).toContain('const PIP_LABEL: &str = "computer-use-pip"');
    expect(capability.windows).toEqual(['computer-use-pip']);
    expect(capability.permissions).toEqual(['allow-pip-window-commands']);
    expect(capability.remote).toBeUndefined();
  });
});
