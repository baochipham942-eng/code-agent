// ============================================================================
// SkillCautionPromptHost - 聊天面 skill caution 确认弹窗宿主（App 级单挂）
// ============================================================================
// 拖拽 ZIP / /plugins install 命中的 caution 确认面。状态机复用设置页的
// useSkillCautionFlow，弹窗本体就是设置页同款 SkillCautionDisclosureModal——
// 所有 GUI 安装入口共用同一张确认面。取消 = 不装（host 侧本就未落盘）+
// 「未安装」提示；确认 = 携 host 下发的 token 由请求方闭包重发。确认重发在途
// 被新流程顶掉时：结算以重发落地为准（见 skillCautionPrompt.ts），迟到的本轮
// 回调只许返回 false，不得关掉/清空当前正显示的新流程确认窗。
// 挂在 App.tsx（ChatView 与 ProjectComposer 两个 ChatInput 挂载点的最近公共
// 常驻父级）：弹窗走 portal，宿主自身不占布局。
// ============================================================================

import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { toast } from '../hooks/useToast';
import { useI18n } from '../hooks/useI18n';
import { getSkillCautionSourceLabel, useSkillCautionFlow } from './features/settings/tabs/useSkillCautionFlow';
import { SkillCautionDisclosureModal } from './features/settings/tabs/SkillCautionDisclosureModal';
import {
  clearSkillCautionPrompt,
  getSkillCautionPromptRequest,
  subscribeSkillCautionPrompt,
  type SkillCautionPromptRequest,
} from '../services/skillCautionPrompt';

export const SkillCautionPromptHost: React.FC = () => {
  const { t } = useI18n();
  const cautionText = t.settings.skills.caution;
  const request = useSyncExternalStore(subscribeSkillCautionPrompt, getSkillCautionPromptRequest);
  const {
    cautionDisclosure,
    cautionBusy,
    requestSkillCautionConfirmation,
    closeSkillCaution,
    confirmSkillCaution,
  } = useSkillCautionFlow();
  // 当前弹窗对应的请求：取消时只结算自己这一轮，不能误清后来顶上的新请求
  const entryRef = useRef<SkillCautionPromptRequest | null>(null);

  useEffect(() => {
    if (!request) return;
    entryRef.current = request;
    requestSkillCautionConfirmation({
      pluginName: request.required.pluginSpec,
      sourceLabel: getSkillCautionSourceLabel(request.required.sourceTrust, cautionText.sourceLabels),
      hits: request.required.cautionHits,
      onConfirm: async () => {
        const done = await request.retry(request.required.confirmationToken);
        // chain 已在 retry 落地的一拍内按真实结局结算；这里只管窗口：自己已不是
        // 当前请求（被新流程顶掉，或同流程重开出了新轮次）时必须返回 false——
        // 返回 true 会让 useSkillCautionFlow 关掉当前显示的别人确认窗、清掉别人
        // 的确认回调，把活流程挂死
        const stillCurrent = getSkillCautionPromptRequest()?.id === request.id;
        if (done && stillCurrent) clearSkillCautionPrompt(request.id);
        return done && stillCurrent;
      },
    });
  }, [request, cautionText.sourceLabels, requestSkillCautionConfirmation]);

  const handleCancel = () => {
    const entry = entryRef.current;
    closeSkillCaution();
    if (!entry) return;
    entryRef.current = null;
    clearSkillCautionPrompt(entry.id);
    entry.resolve(false);
    toast.info(`${cautionText.notInstalledPrefix}${entry.required.pluginSpec}`);
  };

  if (!cautionDisclosure) return null;
  return (
    <SkillCautionDisclosureModal
      mode={cautionDisclosure.mode}
      pluginName={cautionDisclosure.pluginName}
      sourceLabel={cautionDisclosure.sourceLabel}
      hits={cautionDisclosure.hits}
      busy={cautionBusy}
      onConfirm={cautionDisclosure.mode === 'confirm' ? confirmSkillCaution : undefined}
      onClose={handleCancel}
    />
  );
};
