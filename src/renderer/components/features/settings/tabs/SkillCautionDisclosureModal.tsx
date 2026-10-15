// ============================================================================
// SkillCautionDisclosureModal - skill 安装 caution 披露弹窗
// ============================================================================
// host 装载扫描的 caution 档（非 block）在两种场景回到 renderer：
// - official-registry：安装已放行完成，本弹窗 acknowledge-only（列表 + OK）；
// - 未签名 archive / 本地 zip / marketplace：host 返回 SKILL_CAUTION_CONFIRMATION_REQUIRED，
//   本弹窗 confirm 模式（取消=不装；确认=由调用页携 cautionConfirmationToken 重发）。
// 正文按 ruleId 分组，每组一句白话风险描述（i18n 叶子 zh/enSkillCautionRules）+ 命中数；
// ruleId / 文件 / 原文摘录折进「命中明细」折叠区（primitives Button 切换）——非程序员
// 先读人话再决定，需要核对原始命中时再展开。运行时审批真相一行（runtimeApprovalLine）
// 的措辞跟本单验证结论锁定，改审批行为需同步改这句。
// shell 抄同目录 SkillInstallPreviewModal（Modal + ModalFooter / useI18n）；
// 视觉参照 PluginInstallDisclosure（警示图标、Pill），但不沾 capabilityPackage 信任模型。
// ============================================================================

import React, { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import type { SkillInstallCautionHit } from '@shared/contract/skillInstallCaution';
import { Button, Modal, ModalFooter } from '../../../primitives';
import { useI18n } from '../../../../hooks/useI18n';
import { interpolate } from '../../../../i18n/interpolate';
import { Pill } from './PluginsSettings.ui';

export interface SkillCautionDisclosureModalProps {
  /** acknowledge：仅知悉（registry 已装完）；confirm：需显式确认才继续安装 */
  mode: 'acknowledge' | 'confirm';
  pluginName: string;
  sourceLabel: string;
  hits: SkillInstallCautionHit[];
  /** confirm 模式确认中：禁用两个按钮与 ESC/遮罩关闭 */
  busy: boolean;
  /** confirm 模式的确认回调（调用页闭包内已带最新 token）；acknowledge 模式不传 */
  onConfirm?: () => void;
  onClose: () => void;
}

/** 命中按 ruleId 分组（正文一行一类风险），保持首次出现顺序 */
function groupHitsByRule(hits: SkillInstallCautionHit[]): Map<string, SkillInstallCautionHit[]> {
  const groups = new Map<string, SkillInstallCautionHit[]>();
  for (const hit of hits) {
    const existing = groups.get(hit.ruleId);
    if (existing) {
      existing.push(hit);
    } else {
      groups.set(hit.ruleId, [hit]);
    }
  }
  return groups;
}

/** 命中按文件分组（明细区沿用），保持首次出现顺序 */
function groupHitsByFile(hits: SkillInstallCautionHit[]): Map<string, SkillInstallCautionHit[]> {
  const groups = new Map<string, SkillInstallCautionHit[]>();
  for (const hit of hits) {
    const existing = groups.get(hit.file);
    if (existing) {
      existing.push(hit);
    } else {
      groups.set(hit.file, [hit]);
    }
  }
  return groups;
}

export const SkillCautionDisclosureModal: React.FC<SkillCautionDisclosureModalProps> = ({
  mode,
  pluginName,
  sourceLabel,
  hits,
  busy,
  onConfirm,
  onClose,
}) => {
  const { t } = useI18n();
  const [showDetails, setShowDetails] = useState(false);
  const cautionText = t.settings.skills.caution;

  /** ruleId → 白话风险句：嵌入密钥前缀共用一句；未知 id 走兜底（带出原始规则名） */
  const riskSentenceFor = (ruleId: string): string => {
    if (ruleId.startsWith('embedded_secret_medium:')) return cautionText.embeddedSecret;
    return cautionText.rules[ruleId] ?? interpolate(cautionText.fallback, { rule: ruleId });
  };

  return (
    <Modal
      isOpen
      onClose={busy ? undefined : onClose}
      closeOnBackdropClick={!busy}
      closeOnEsc={!busy}
      size="lg"
      title={cautionText.title}
      headerIcon={<AlertTriangle className="h-5 w-5 text-badge-warning" />}
      footer={mode === 'confirm' ? (
        <ModalFooter
          cancelText={t.common.cancel}
          confirmText={busy ? cautionText.confirming : cautionText.confirmInstall}
          onCancel={onClose}
          onConfirm={onConfirm}
          confirmDisabled={busy}
          cancelDisabled={busy}
          cancelAutoFocus
        />
      ) : (
        <ModalFooter
          hideCancel
          confirmText={cautionText.okButton}
          onConfirm={onClose}
          confirmDisabled={busy}
        />
      )}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-zinc-100">{pluginName}</h3>
          <Pill tone="warning">{sourceLabel}</Pill>
        </div>

        <p className="text-xs leading-5 text-zinc-400">
          {mode === 'confirm' ? cautionText.confirmExplanation : cautionText.acknowledgeExplanation}
        </p>

        {/* 装后运行时审批真相（见文件头注释：措辞与已验证行为锁定） */}
        <p className="rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-2 text-xs leading-5 text-zinc-400">
          {cautionText.runtimeApprovalLine}
        </p>

        <div className="text-xs font-medium text-zinc-300">
          {interpolate(cautionText.hitsCount, { count: hits.length })}
        </div>

        {/* 正文：按规则分组的一句白话风险 + 命中数；规则名与原文折进明细 */}
        <div className="rounded-lg border border-zinc-700 bg-zinc-800/60">
          <ul className="divide-y divide-zinc-700/60">
            {[...groupHitsByRule(hits)].map(([ruleId, ruleHits]) => (
              <li key={ruleId} className="flex items-start justify-between gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 text-xs leading-5 text-zinc-200">
                  {riskSentenceFor(ruleId)}
                </span>
                <span className="shrink-0 text-xs leading-5 text-zinc-500">
                  {interpolate(cautionText.hitCount, { count: ruleHits.length })}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowDetails((value) => !value)}
          aria-expanded={showDetails}
          leftIcon={showDetails
            ? <ChevronUp className="h-3 w-3" />
            : <ChevronDown className="h-3 w-3" />}
        >
          {showDetails ? cautionText.detailsHide : cautionText.detailsShow}
        </Button>

        {showDetails && (
          <div className="space-y-3">
            {[...groupHitsByFile(hits)].map(([file, fileHits]) => (
              <div key={file} className="rounded-lg border border-zinc-700 bg-zinc-800/60">
                <div className="truncate border-b border-zinc-700 px-3 py-2 font-mono text-xs text-zinc-300" title={file}>
                  {file}
                </div>
                <ul className="divide-y divide-zinc-700/60">
                  {fileHits.map((hit, index) => (
                    <li key={`${hit.ruleId}-${index}`} className="flex items-center gap-2 px-3 py-2">
                      <span className="shrink-0 font-mono">
                        <Pill tone="warning">{hit.ruleId}</Pill>
                      </span>
                      {/* 纯文本渲染（React 转义），绝不当 markdown/HTML 处理 */}
                      <span className="min-w-0 flex-1 truncate text-xs text-zinc-300" title={hit.snippet}>
                        {hit.snippet}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
};
