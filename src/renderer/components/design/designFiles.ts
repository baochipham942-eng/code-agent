// 设计工作区的工作区文件读取工具（renderer 侧，经 WORKSPACE domain IPC）。
// hook 轮询与历史加载共用，避免重复。
import { IPC_DOMAINS } from '@shared/ipc';
import type { FileInfo } from '@shared/contract/workspace';

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
