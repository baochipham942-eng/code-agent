// 设计工作区的工作区文件读取工具（renderer 侧，经 WORKSPACE domain IPC）。
// hook 轮询与历史加载共用，避免重复。
import { IPC_DOMAINS } from '@shared/ipc';
import { DESIGN_VERSIONS_SUBDIR } from '@shared/constants';
import type { FileInfo } from '@shared/contract/workspace';
import { versionFileName, parseVersionTs } from './designTypes';

/** 一次原型版本快照。 */
export type DesignVersion = {
  /** 快照文件绝对路径（唯一 id）。 */
  path: string;
  /** 创建时间戳（从文件名解析）。 */
  createdAt: number;
};

export async function readWorkspaceFile(filePath: string): Promise<string | null> {
  try {
    const res = await window.domainAPI?.invoke<string>(IPC_DOMAINS.WORKSPACE, 'readFile', {
      filePath,
    });
    return res?.success ? ((res.data as string) ?? '') : null;
  } catch {
    return null;
  }
}

/** 列 run 目录里的 html 文件路径（优先 prototype.html，否则任一 .html）；无则返回 null。 */
export async function findRunHtml(dirPath: string): Promise<string | null> {
  try {
    const res = await window.domainAPI?.invoke<FileInfo[]>(IPC_DOMAINS.WORKSPACE, 'listFiles', {
      dirPath,
    });
    if (!res?.success || !Array.isArray(res.data)) return null;
    const htmls = res.data.filter((f) => !f.isDirectory && /\.html?$/i.test(f.name));
    if (htmls.length === 0) return null;
    const preferred = htmls.find((f) => /^prototype\./i.test(f.name));
    return (preferred ?? htmls[0]).path;
  } catch {
    return null;
  }
}

/** 读取某 run 目录里最新 html 的内容（用于历史加载/刷新恢复）。 */
export async function readRunHtml(runDir: string): Promise<string | null> {
  const htmlPath = await findRunHtml(runDir);
  return htmlPath ? readWorkspaceFile(htmlPath) : null;
}

/** 写入工作区文件（覆盖）。成功返回 true。 */
export async function writeWorkspaceFile(filePath: string, content: string): Promise<boolean> {
  try {
    const res = await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'writeFile', {
      filePath,
      content,
    });
    return res?.success === true;
  } catch {
    return false;
  }
}

/** 把当前原型 html 快照成一份版本文件（versions/v-<ts>.html）。失败静默。 */
export async function snapshotVersion(runDir: string, html: string, ts: number): Promise<void> {
  const versionsDir = `${runDir.replace(/\/+$/, '')}/${DESIGN_VERSIONS_SUBDIR}`;
  try {
    await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'createFolder', { dirPath: versionsDir });
  } catch {
    // 已存在则忽略（createFolder 非递归、存在即抛）。
  }
  await writeWorkspaceFile(`${versionsDir}/${versionFileName(ts)}`, html);
}

/** 列某 run 的版本快照，按创建时间倒序（最新在前）。 */
export async function listVersions(runDir: string): Promise<DesignVersion[]> {
  const versionsDir = `${runDir.replace(/\/+$/, '')}/${DESIGN_VERSIONS_SUBDIR}`;
  try {
    const res = await window.domainAPI?.invoke<FileInfo[]>(IPC_DOMAINS.WORKSPACE, 'listFiles', {
      dirPath: versionsDir,
    });
    if (!res?.success || !Array.isArray(res.data)) return [];
    return res.data
      .map((f) => ({ path: f.path, createdAt: parseVersionTs(f.name) }))
      .filter((v): v is DesignVersion => v.createdAt != null)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}
