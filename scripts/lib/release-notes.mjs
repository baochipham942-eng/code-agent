import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 生成「更新内容」发布说明，供 latest.json(notes) 与 release.json(body) 共用，
 * 让用户在更新弹窗里看到真实 changelog 而非占位符。优先级：
 *   1) 显式 notesPath 或 docs/releases/v<version>.md 存在且非空 → 直接用其内容
 *   2) 否则取 上个 tag..HEAD 的提交（剔除 merge 提交与 chore(release) 噪音）拼成列表
 *   3) 都拿不到（浅克隆 / 无 git 元数据 / 首个版本）→ 回退 "Agent Neo v<version>"
 *
 * @param {string} rootDir 仓库根目录
 * @param {string} version 版本号（不带 v）
 * @param {string} [notesPath] 可选的显式说明文件路径（相对 rootDir 或绝对）
 * @returns {Promise<string>}
 */
export async function loadReleaseNotes(rootDir, version, notesPath) {
  const resolvedNotesPath = notesPath
    ? path.resolve(rootDir, notesPath)
    : path.join(rootDir, 'docs', 'releases', `v${version}.md`);

  if (await exists(resolvedNotesPath)) {
    const content = (await readFile(resolvedNotesPath, 'utf8')).trim();
    if (content) return content;
  }

  try {
    const { stdout: previousTag } = await execFileAsync(
      'git',
      ['describe', '--tags', '--abbrev=0', 'HEAD^'],
      { cwd: rootDir },
    );
    const range = `${previousTag.trim()}..HEAD`;
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--no-merges', '--pretty=format:%s', range],
      { cwd: rootDir },
    );
    const lines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^chore\(release\)/i.test(line) && !/^Merge\s/i.test(line));
    if (lines.length > 0) {
      return lines.map((line) => `- ${line}`).join('\n');
    }
  } catch {
    // 浅克隆 / 无 git 元数据 / 首个版本：回退到下面的占位文案
  }

  return `Agent Neo v${version}`;
}
