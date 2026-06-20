// 设计原型生成 hook（Kun 借鉴 B3·A·文件态）。
//
// 流程：点"生成" → 为本次生成开一个独立 run 子目录（app 托管，免手动选工作目录）
// → 拼原型 prompt → 在专用会话里发给现有 Agent loop → Agent 把单文件 HTML 写到该
// 目录（P2 设计质量 hook 会在写入时自动触发）→ 本 hook 轮询该目录里最新的 html，
// 边长边刷预览 iframe；会话从"处理中"转 idle 即定稿。
//
// 预览按「目录里最新 html」抓（与文件名/写入工具解耦），完成判定以会话处理状态为准
// （文件大小稳定不可靠：骨架后 MiMo 思考停顿时长不定）。详见借鉴清单 Bug B。
import { useCallback } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import { DESIGN_WORKSPACE } from '@shared/constants';
import { useAgent } from '../../hooks/useAgent';
import { useI18n } from '../../hooks/useI18n';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { useDesignStore } from './designStore';
import { buildPrototypePrompt, buildContinueEditPrompt, type PrototypeSelection } from './designTypes';
import { findRunHtml, readWorkspaceFile, snapshotVersion, listVersions } from './designFiles';

/** 预创建 run 目录（让 createSession 工作目录有效、listFiles 有目标）。 */
async function ensureDir(dirPath: string): Promise<void> {
  try {
    await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'createFolder', { dirPath });
  } catch {
    // Agent 写文件时也会建父目录，这里失败不致命。
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 一次完成定稿后把当前 html 快照成版本，并刷新 store 的版本列表（backlog #4）。 */
async function captureVersion(runDir: string, html: string): Promise<void> {
  await snapshotVersion(runDir, html, Date.now());
  useDesignStore.getState().setVersions(await listVersions(runDir));
}

/**
 * 轮询 run 目录里的 html，每轮都把最新内容刷进预览。完成判定**以会话处理状态为准**
 * （会话从"处理中"转为 idle 即定稿）；文件稳定仅作"拿不到处理状态"时的兜底。
 */
async function pollPreview(runDir: string, sessionId: string | null, timeoutMsg: string): Promise<void> {
  const store = useDesignStore;
  const deadline = Date.now() + DESIGN_WORKSPACE.POLL_TIMEOUT_MS;
  let lastLen = -1;
  let stableRounds = 0;
  let everProcessing = false;
  while (Date.now() < deadline) {
    // 被新一轮生成 / 切换历史 / 重置取代 → 放弃本轮轮询。
    if (store.getState().previewPath !== runDir) return;

    const htmlPath = await findRunHtml(runDir);
    const content = htmlPath ? await readWorkspaceFile(htmlPath) : null;
    let complete = false;
    if (content && content.length > 0) {
      if (content.length !== lastLen) {
        store.getState().setPreviewHtml(content);
        lastLen = content.length;
        stableRounds = 0;
      } else {
        stableRounds += 1;
      }
      complete = /<\/html>/i.test(content);
    }

    const processing = sessionId
      ? useAppStore.getState().processingSessionIds.has(sessionId)
      : false;
    if (processing) everProcessing = true;
    if (everProcessing && !processing) {
      // 会话结束 → 定稿：再读一次拿最终完整内容（轮询读可能落后于最后一次写，
      // 导致预览停在中间态）。读到收尾内容才算完成，否则继续轮询兜底。
      const finalPath = await findRunHtml(runDir);
      const finalHtml = finalPath ? await readWorkspaceFile(finalPath) : null;
      if (finalHtml && finalHtml.length > 0) {
        store.getState().setPreviewHtml(finalHtml);
        if (/<\/html>/i.test(finalHtml)) {
          await captureVersion(runDir, finalHtml);
          store.getState().setDone();
          return;
        }
      }
    }
    if (!sessionId && complete && stableRounds >= DESIGN_WORKSPACE.STABLE_ROUNDS) {
      store.getState().setDone();
      return;
    }
    await sleep(DESIGN_WORKSPACE.POLL_INTERVAL_MS);
  }
  if (store.getState().previewHtml) store.getState().setDone();
  else store.getState().setError(timeoutMsg);
}

export function useDesignGeneration(): {
  generate: () => Promise<void>;
  continueEdit: (instruction: string, selection?: PrototypeSelection) => Promise<void>;
} {
  const { sendMessage } = useAgent();
  const { t } = useI18n();

  /** 把一段 prompt 派发给一个新建的设计会话（工作目录锁到 runDir），不抢占用户当前聊天。 */
  const dispatchToRun = useCallback(
    async (runDir: string, prompt: string, sessionTitle: string): Promise<void> => {
      const prevSessionId = useSessionStore.getState().currentSessionId;
      const session = await useSessionStore
        .getState()
        .createSession(sessionTitle, { workingDirectory: runDir });
      if (!session) {
        useDesignStore.getState().setError(t.design.errDispatch);
        return;
      }
      // createSession 会激活设计会话；立即切回用户原会话，发消息时用 sessionId 指定
      // 发给设计会话（envelope.sessionId 优先），处理状态按 id 全局跟踪，预览轮询不受影响。
      if (prevSessionId && prevSessionId !== session.id) {
        await useSessionStore.getState().switchSession(prevSessionId);
      }
      await sendMessage({
        content: prompt,
        sessionId: session.id,
        context: { workingDirectory: runDir },
      });
      void pollPreview(runDir, session.id, t.design.errTimeout);
    },
    [sendMessage, t],
  );

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
    const requirement = st.requirement;
    const prompt = buildPrototypePrompt({
      requirement,
      reservedPath,
      designContext: {
        surface: st.surface ?? undefined,
        brandColor: st.brandColor.trim() || undefined,
        tone: st.tone,
      },
    });

    st.startGenerating({ runDir, requirement, createdAt: Date.now() });
    await ensureDir(runDir);
    try {
      await dispatchToRun(runDir, prompt, `${t.design.title}：${requirement.slice(0, 12)}`);
    } catch (e) {
      useDesignStore.getState().setError(e instanceof Error ? e.message : t.design.errDispatch);
    }
  }, [dispatchToRun, t]);

  /**
   * 在当前选中的原型上续编：复用同一 run 目录，让 Agent 用 Edit 局部改现有文件，
   * 预览原地刷新（不闪空）。selection 来自预览圈选（backlog #2），可空（纯对话续编）。
   */
  const continueEdit = useCallback(
    async (instruction: string, selection?: PrototypeSelection) => {
      const st = useDesignStore.getState();
      const runDir = st.selectedRunDir;
      if (!runDir) {
        st.setError(t.design.errNoPrototype);
        return;
      }
      if (!instruction.trim()) {
        st.setError(t.design.errNoInstruction);
        return;
      }
      const existing = await findRunHtml(runDir);
      const reservedPath = existing ?? `${runDir}/prototype.html`;
      const prompt = buildContinueEditPrompt({ reservedPath, instruction, selection });
      st.startEditing(runDir);
      try {
        await dispatchToRun(runDir, prompt, `${t.design.title}：${t.design.continueEditTitle}`);
      } catch (e) {
        useDesignStore.getState().setError(e instanceof Error ? e.message : t.design.errDispatch);
      }
    },
    [dispatchToRun, t],
  );

  return { generate, continueEdit };
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
