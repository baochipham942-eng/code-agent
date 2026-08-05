// ============================================================================
// localAppIcon —— 从本机已安装的 .app 包里提取引擎图标（darwin 专用）。
// 引擎的「已检测」来自本机安装，图标同样取自本机安装：不在仓库里分发第三方
// 商标资产，装了对应 app 的用户看到真图标，没装的回退首字母瓦片。
// Windows 取 exe 图标需要原生依赖，暂不支持（回退瓦片）。
// ============================================================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

// appPath → dataUrl（null = 提取失败，负缓存避免每次探测都重跑 sips）
const iconCache = new Map<string, string | null>();

async function findAppPath(appNames: readonly string[]): Promise<string | null> {
  const roots = ['/Applications', path.join(os.homedir(), 'Applications')];
  for (const name of appNames) {
    for (const root of roots) {
      const candidate = path.join(root, name);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // 下一个候选
      }
    }
  }
  return null;
}

async function readBundleIconPath(appPath: string): Promise<string | null> {
  // Info.plist 的 CFBundleIconFile 可能省略 .icns 后缀；读不到就捞 Resources 下第一个 icns
  try {
    const { stdout } = await execFileAsync('defaults', [
      'read',
      path.join(appPath, 'Contents', 'Info'),
      'CFBundleIconFile',
    ]);
    let name = stdout.trim();
    if (name) {
      if (!name.endsWith('.icns')) name += '.icns';
      const candidate = path.join(appPath, 'Contents', 'Resources', name);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // 落到目录扫描
      }
    }
  } catch {
    // 落到目录扫描
  }
  try {
    const resources = path.join(appPath, 'Contents', 'Resources');
    const entries = await fs.readdir(resources);
    const icns = entries.find((entry) => entry.endsWith('.icns'));
    if (icns) return path.join(resources, icns);
  } catch {
    // 无 Resources
  }
  return null;
}

export async function resolveLocalAppIconDataUrl(
  appNames?: readonly string[],
): Promise<string | undefined> {
  if (process.platform !== 'darwin' || !appNames?.length) return undefined;
  const appPath = await findAppPath(appNames);
  if (!appPath) return undefined;
  if (iconCache.has(appPath)) return iconCache.get(appPath) ?? undefined;
  let dataUrl: string | null = null;
  try {
    const icns = await readBundleIconPath(appPath);
    if (icns) {
      const out = path.join(
        os.tmpdir(),
        `neo-engine-icon-${path.basename(appPath).replace(/[^\w.-]/g, '_')}.png`,
      );
      // 64px 足够 32px 槽位的 2x 显示，控制 data URL 体积
      await execFileAsync('sips', ['-s', 'format', 'png', '-Z', '64', icns, '--out', out]);
      const buffer = await fs.readFile(out);
      dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
      await fs.rm(out, { force: true });
    }
  } catch {
    dataUrl = null;
  }
  iconCache.set(appPath, dataUrl);
  return dataUrl ?? undefined;
}
