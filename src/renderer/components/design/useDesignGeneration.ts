// 设计原型生成 hook（Kun 借鉴 B3·A·文件态）。
//
// 流程：点"生成" → 解析 app 托管的设计草稿目录（免手动选工作目录）→ 拼原型
// prompt → 在专用会话里发给现有 Agent loop → Agent 用 Write 工具把单文件 HTML
// 写到预留路径（P2 设计质量 hook 会在写入时自动触发）→ 本 hook 轮询读取该文件，
// 边长边刷预览 iframe。
//
// 复用现有 useAgent / sessionStore / workspace IPC，不新建生成管线。
import { useCallback } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import { DESIGN_WORKSPACE } from '@shared/constants';
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

/** 解析 app 托管的设计草稿目录（主进程侧返回绝对路径，已确保存在）。 */
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询预留路径，边长边刷预览；检测到 </html> 收尾则完成，超时则按是否已有内容判定。 */
async function pollPreview(absPath: string, timeoutMsg: string): Promise<void> {
  const store = useDesignStore;
  const deadline = Date.now() + DESIGN_WORKSPACE.POLL_TIMEOUT_MS;
  let lastLen = -1;
  let stableRounds = 0;
  while (Date.now() < deadline) {
    // 被新一轮生成或重置取代 → 放弃本轮轮询。
    if (store.getState().previewPath !== absPath) return;
    const content = await readWorkspaceFile(absPath);
    if (content && content.length > 0) {
      if (content.length !== lastLen) {
        // 内容仍在增长（Agent 骨架→填充）：持续刷新预览，重置静默计数。
        store.getState().setPreviewHtml(content);
        lastLen = content.length;
        stableRounds = 0;
      } else {
        stableRounds += 1;
      }
      // 只有"已收尾(</html>) 且 大小连续多轮不变"才算完成，避免冻结在骨架。
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

    const absPath = `${baseDir.replace(/\/+$/, '')}/prototype-${Date.now()}.html`;
    const prompt = buildPrototypePrompt({
      requirement: st.requirement,
      reservedPath: absPath,
      designContext: {
        surface: st.surface ?? undefined,
        brandColor: st.brandColor.trim() || undefined,
        tone: st.tone,
      },
    });

    st.startGenerating(absPath);
    try {
      await useSessionStore
        .getState()
        .createSession(`${t.design.title}：${st.requirement.slice(0, 12)}`, {
          workingDirectory: baseDir,
        });
      await sendMessage({ content: prompt, context: { workingDirectory: baseDir } });
    } catch (e) {
      useDesignStore.getState().setError(e instanceof Error ? e.message : t.design.errDispatch);
      return;
    }
    void pollPreview(absPath, t.design.errTimeout);
  }, [sendMessage, t]);

  return { generate };
}
