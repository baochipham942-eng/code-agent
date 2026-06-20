// 设计原型生成 hook（Kun 借鉴 B3·A·文件态）。
//
// 流程：点"生成" → 拼原型 prompt → 在专用会话里发给现有 Agent loop →
// Agent 用 Write 工具把单文件 HTML 写到预留路径（P2 设计质量 hook 会在写入时
// 自动触发）→ 本 hook 轮询读取该文件，边长边刷新预览 iframe。
//
// 复用现有 useAgent / sessionStore / workspace readFile，不新建生成管线。
import { useCallback } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import { DESIGN_WORKSPACE } from '@shared/constants';
import { useAgent } from '../../hooks/useAgent';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询预留路径，边长边刷预览；检测到 </html> 收尾则完成，超时则按是否已有内容判定。 */
async function pollPreview(absPath: string): Promise<void> {
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
        store.getState().setPreviewHtml(content);
        lastLen = content.length;
        stableRounds = 0;
      } else {
        stableRounds += 1;
      }
      if (/<\/html>/i.test(content) && stableRounds >= 1) {
        store.getState().setDone();
        return;
      }
    }
    await sleep(DESIGN_WORKSPACE.POLL_INTERVAL_MS);
  }
  if (store.getState().previewHtml) store.getState().setDone();
  else store.getState().setError('生成超时，未检测到原型文件');
}

export function useDesignGeneration(): { generate: () => Promise<void> } {
  const { sendMessage } = useAgent();

  const generate = useCallback(async () => {
    const st = useDesignStore.getState();
    const workingDirectory = useAppStore.getState().workingDirectory;

    if (st.outputType !== 'prototype') {
      st.setError('设计稿 / 信息图即将支持，当前先用「交互原型」');
      return;
    }
    if (!workingDirectory) {
      st.setError('请先在 Code 模式选择工作目录（设计产物会写到该目录下）');
      return;
    }
    if (!st.requirement.trim()) {
      st.setError('请先填写需求描述');
      return;
    }

    const relPath = `${DESIGN_WORKSPACE.OUTPUT_DIR}/prototype-${Date.now()}.html`;
    const absPath = `${workingDirectory.replace(/\/+$/, '')}/${relPath}`;
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
        .createSession(`设计：${st.requirement.slice(0, 12)}`, { workingDirectory });
      await sendMessage({ content: prompt, context: { workingDirectory } });
    } catch (e) {
      useDesignStore.getState().setError(e instanceof Error ? e.message : '生成派发失败');
      return;
    }
    void pollPreview(absPath);
  }, [sendMessage]);

  return { generate };
}
