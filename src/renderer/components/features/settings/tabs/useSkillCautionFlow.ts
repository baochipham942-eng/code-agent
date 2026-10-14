// ============================================================================
// useSkillCautionFlow - skill 安装 caution 披露流的页面级状态机
// ============================================================================
// 两个设置页（SkillsSettings：registry acknowledge + 本地 ZIP confirm；
// PluginsSettings：marketplace confirm）共用。弹窗本体是 SkillCautionDisclosureModal，
// 本 hook 只管：弹窗开/关、confirm 的 busy 闸、以及「二次 confirmation-required
// （内容变了）用新命中重开」的闭包续约——确认回调由调用页提供，闭包内自带
// host 最新下发的 confirmationToken。
// ============================================================================

import { useCallback, useRef, useState } from 'react';
import type {
  SkillCautionConfirmationRequired,
  SkillInstallCautionHit,
} from '@shared/contract/skillInstallCaution';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('useSkillCautionFlow');

interface SkillCautionDisclosureState {
  mode: 'acknowledge' | 'confirm';
  pluginName: string;
  sourceLabel: string;
  hits: SkillInstallCautionHit[];
}

/** caution 来源 → 展示标签（文案表在 t.settings.skills.caution.sourceLabels） */
export function getSkillCautionSourceLabel(
  sourceTrust: SkillCautionConfirmationRequired['sourceTrust'],
  labels: Record<SkillCautionConfirmationRequired['sourceTrust'], string>,
): string {
  return labels[sourceTrust];
}

export interface UseSkillCautionFlowResult {
  cautionDisclosure: SkillCautionDisclosureState | null;
  cautionBusy: boolean;
  /** registry（official-registry）装完后知悉披露：只列表 + OK，无确认语义 */
  acknowledgeSkillCaution: (args: {
    pluginName: string;
    sourceLabel: string;
    hits: SkillInstallCautionHit[];
  }) => void;
  /**
   * 未签名来源装前确认。onConfirm 返回 true = 流程收尾（成功/失败都已按正常路径
   * 处理）→ 关窗；返回 false = 已用新命中调本函数重开（内容变化的二次确认）。
   */
  requestSkillCautionConfirmation: (args: {
    pluginName: string;
    sourceLabel: string;
    hits: SkillInstallCautionHit[];
    onConfirm: () => Promise<boolean>;
  }) => void;
  /** 取消/关闭：confirm 模式即放弃安装（host 侧本就未落盘） */
  closeSkillCaution: () => void;
  confirmSkillCaution: () => Promise<void>;
}

export function useSkillCautionFlow(): UseSkillCautionFlowResult {
  const [disclosure, setDisclosure] = useState<SkillCautionDisclosureState | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<(() => Promise<boolean>) | null>(null);

  const acknowledgeSkillCaution = useCallback(
    (args: { pluginName: string; sourceLabel: string; hits: SkillInstallCautionHit[] }) => {
      confirmRef.current = null;
      setDisclosure({ mode: 'acknowledge', ...args });
    },
    [],
  );

  const requestSkillCautionConfirmation = useCallback(
    (args: {
      pluginName: string;
      sourceLabel: string;
      hits: SkillInstallCautionHit[];
      onConfirm: () => Promise<boolean>;
    }) => {
      confirmRef.current = args.onConfirm;
      setDisclosure({
        mode: 'confirm',
        pluginName: args.pluginName,
        sourceLabel: args.sourceLabel,
        hits: args.hits,
      });
    },
    [],
  );

  const closeSkillCaution = useCallback(() => {
    if (busy) return;
    confirmRef.current = null;
    setDisclosure(null);
  }, [busy]);

  const confirmSkillCaution = useCallback(async () => {
    const confirm = confirmRef.current;
    if (!confirm || busy) return;
    setBusy(true);
    let shouldClose: boolean;
    try {
      shouldClose = await confirm();
    } catch (err) {
      // 调用页的 onConfirm 应自行消化 IPC 失败（错误条/notice）；这里兜底留痕并保持
      // 弹窗开着等用户决定，不让 rejection 悬空
      logger.error('Skill caution confirm flow failed', err);
      shouldClose = false;
    } finally {
      setBusy(false);
    }
    if (shouldClose) {
      confirmRef.current = null;
      setDisclosure(null);
    }
  }, [busy]);

  return {
    cautionDisclosure: disclosure,
    cautionBusy: busy,
    acknowledgeSkillCaution,
    requestSkillCautionConfirmation,
    closeSkillCaution,
    confirmSkillCaution,
  };
}
