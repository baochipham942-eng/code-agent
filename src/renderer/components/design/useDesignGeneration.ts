// 设计原型生成 hook（Kun 借鉴 B3·A·文件态）。
//
// 流程：点"生成" → 为本次生成开一个独立 run 子目录（app 托管，免手动选工作目录）
// → 拼原型 prompt → 在专用会话里发给现有 Agent loop → Agent 把单文件 HTML 写到该
// 目录（P2 设计质量 hook 会在写入时自动触发）→ 本 hook 轮询该目录里最新的 html，
// 边长边刷预览 iframe。
//
// 预览刻意按「目录里最新 html」而非精确文件名来抓：Agent 可能用 Write、也可能在
// Write 被 repair 闸拦截时退回 Bash、甚至自己改名（dogfood 实测，见借鉴清单 Bug B）。
// 用独立 run 目录 + 抓最新 html，与具体文件名/写入工具彻底解耦。
import { useCallback } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import { DESIGN_WORKSPACE } from '@shared/constants';
import type { FileInfo } from '@shared/contract/workspace';
import { useAgent } from '../../hooks/useAgent';
import { useI18n } from '../../hooks/useI18n';
import { useSessionStore } from '../../stores/sessionStore';
import { useDesignStore } from './designStore';
import { buildPrototypePrompt } from './designTypes';

async function readWorkspaceFile(filePath: string): Promise<string | null> {
  try {
    const res = await window.domainAPI?.invoke<string>(IPC_DOMAINS.WORKSPACE, 'readFile', {
      filePath,
    });
    return res?.success ? ((res.data as string) ?? '') : null;
  } catch {
    return null;
  }
}

/** 列目录里的 html 文件路径（优先 prototype.html，否则任一 .html）；目录不存在时返回 null。 */
async function findRunHtml(dirPath: string): Promise<string | null> {
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

/** 解析 app 托管的设计草稿根目录（主进程侧返回绝对路径，已确保存在）。 */
async function resolveDesignDir(): Promise<string | null> {
  try {
    const res = await window.domainAPI?.invoke<{ dir: string }>(
      IPC_DOMAINS.WORKSPACE,
      'resolveDesignDir',
      {},
    );
    return res?.success ? (res.data?.dir ?? null) : null;
  } catch {
    return null;
  }
}

/** 预创建 run 目录（让 createSession 工作目录有效、listFiles 有目标）。 */
async function ensureDir(dirPath: string): Promise<void> {
  try {
    await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'createFolder', { dirPath });
  } catch {
    // Agent 写文件时也会建父目录，这里失败不致命。
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询 run 目录里的 html，边长边刷预览；检测到 </html> 收尾且大小连续多轮不变才
 * 算完成（不能一看到 </html> 就停——Agent 先写的骨架已含 </html>，会冻结空骨架）。
 */
async function pollPreview(runDir: string, timeoutMsg: string): Promise<void> {
  const store = useDesignStore;
  const deadline = Date.now() + DESIGN_WORKSPACE.POLL_TIMEOUT_MS;
  let lastLen = -1;
  let stableRounds = 0;
  while (Date.now() < deadline) {
    // 被新一轮生成或重置取代 → 放弃本轮轮询。
    if (store.getState().previewPath !== runDir) return;
    const htmlPath = await findRunHtml(runDir);
    const content = htmlPath ? await readWorkspaceFile(htmlPath) : null;
    if (content && content.length > 0) {
      if (content.length !== lastLen) {
        store.getState().setPreviewHtml(content);
        lastLen = content.length;
        stableRounds = 0;
      } else {
        stableRounds += 1;
      }
      if (/<\/html>/i.test(content) && stableRounds >= DESIGN_WORKSPACE.STABLE_ROUNDS) {
        store.getState().setDone();
        return;
      }
    }
    await sleep(DESIGN_WORKSPACE.POLL_INTERVAL_MS);
  }
  if (store.getState().previewHtml) store.getState().setDone();
  else store.getState().setError(timeoutMsg);
}

export function useDesignGeneration(): { generate: () => Promise<void> } {
  const { sendMessage } = useAgent();
  const { t } = useI18n();

  const generate = useCallback(async () => {
    const st = useDesignStore.getState();

    if (st.outputType !== 'prototype') {
      st.setError(t.design.errImageSoon);
      return;
    }
    if (!st.requirement.trim()) {
      st.setError(t.design.errNoRequirement);
      return;
    }

    const baseDir = await resolveDesignDir();
    if (!baseDir) {
      useDesignStore.getState().setError(t.design.errResolveDir);
      return;
    }

    // 每次生成一个独立 run 目录，预览按「目录里最新 html」抓，与文件名/写入工具解耦。
    const runDir = `${baseDir.replace(/\/+$/, '')}/run-${Date.now()}`;
    const reservedPath = `${runDir}/prototype.html`;
    const prompt = buildPrototypePrompt({
      requirement: st.requirement,
      reservedPath,
      designContext: {
        surface: st.surface ?? undefined,
        brandColor: st.brandColor.trim() || undefined,
        tone: st.tone,
      },
    });

    st.startGenerating(runDir);
    await ensureDir(runDir);
    try {
      await useSessionStore
        .getState()
        .createSession(`${t.design.title}：${st.requirement.slice(0, 12)}`, {
          workingDirectory: runDir,
        });
      await sendMessage({ content: prompt, context: { workingDirectory: runDir } });
    } catch (e) {
      useDesignStore.getState().setError(e instanceof Error ? e.message : t.design.errDispatch);
      return;
    }
    void pollPreview(runDir, t.design.errTimeout);
  }, [sendMessage, t]);

  return { generate };
}
