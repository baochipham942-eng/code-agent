import { useCallback, useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import { invokeDomain } from '../services/ipcService';
import { needsFolderTrustDecision, type FolderTrustEvaluationView } from '../components/FolderTrustDialog';
import { toast } from './useToast';
import { useI18n } from './useI18n';
import { createLogger } from '../utils/logger';

const logger = createLogger('FolderTrustPrompt');

/**
 * 「这个文件夹带了自动化配置，要启用吗？」弹窗的状态与决定回写（从 App.tsx 抽出，N-FIRSTRUN-SKIP）。
 *
 * 只在当前会话真绑到一个文件夹时才评估：无会话、或会话 workingDirectory 为空（首启自动建的快速对话）时，
 * host 都会回退评估 Neo 自己建的 <dataDir>/work（或桌面 home），
 * 拿它问用户「信不信任」既答不上来也没必要——未启用的配置本来就不加载（各消费方
 * isProjectConfigTrusted fail-closed）。对照一手文档：VS Code 只有「空窗口」（没挂任何文件夹）默认全信任，
 * 挂上文件夹一律先受限再问（startupPrompt 默认 never，用横幅不用弹窗）；Claude Code 选「No」也只是不套用
 * 该目录的 allow/hooks/.mcp.json，不退出。Neo 的无会话态就是那个「空窗口」，会话绑定文件夹才是「挂上」。
 */
export function useFolderTrustPrompt(workingDirectory: string | null | undefined) {
  const { t } = useI18n();
  // 弹窗展示的目录与提交决定的目录绑在一起：切目录时确认框还开着，点「启用」不能写到新目录上（ai-review #1636 第 2 轮）。
  const [prompt, setPrompt] = useState<{ directory: string; evaluation: FolderTrustEvaluationView } | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    setPrompt(null);
    if (!workingDirectory) return;
    let cancelled = false;
    // 显式传目录（host resolveWorkingDirectory 的第一优先级）；只传 sessionId 的话，目录为空的会话
    // 会被 host 回退到 <dataDir>/work，等于又回去问「Neo 自己建的目录信不信任」（ai-review #1636 抓出）。
    invokeDomain<FolderTrustEvaluationView>(IPC_DOMAINS.FOLDER_TRUST, 'get', { workingDirectory })
      .then((next) => {
        if (!cancelled && needsFolderTrustDecision(next)) setPrompt({ directory: workingDirectory, evaluation: next });
      })
      .catch((error: unknown) => {
        logger.warn('Failed to evaluate folder trust', { error });
      });
    return () => {
      cancelled = true;
    };
  }, [workingDirectory]);

  const decide = useCallback(async (state: 'trusted' | 'blocked') => {
    const target = prompt;
    if (!target) return;
    setIsBusy(true);
    try {
      const next = await invokeDomain<FolderTrustEvaluationView>(IPC_DOMAINS.FOLDER_TRUST, 'set', {
        state,
        workingDirectory: target.directory,
      });
      // 决定已生效（trusted 或 blocked）就关窗；只有 host 回报仍是未决定态才继续问。
      // 等待期间目录已切走的话，prompt 早被 effect 清掉，这里不再把旧目录的结果塞回去。
      setPrompt((current) => (
        current?.directory === target.directory && needsFolderTrustDecision(next)
          ? { directory: target.directory, evaluation: next }
          : current?.directory === target.directory ? null : current
      ));
    } catch (error) {
      // 只写日志的话按钮看起来「点了没反应」，用户无从知道决定没保存上。
      logger.warn('Failed to update folder trust', { error });
      toast.error(t.folderTrust.saveFailed + (error instanceof Error ? `: ${error.message}` : ''));
    } finally {
      setIsBusy(false);
    }
  }, [prompt, t]);

  return { evaluation: prompt?.evaluation ?? null, isBusy, decide };
}
