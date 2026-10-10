// ============================================================================
// SkillCautionDisclosureModal - skill 安装 caution 披露弹窗
// ============================================================================
// host 装载扫描的 caution 档（非 block）在两种场景回到 renderer：
// - official-registry：安装已放行完成，本弹窗 acknowledge-only（列表 + OK）；
// - 未签名 archive / 本地 zip / marketplace：host 返回 SKILL_CAUTION_CONFIRMATION_REQUIRED，
//   本弹窗 confirm 模式（取消=不装；确认=由调用页携 cautionConfirmationToken 重发）。
// 命中按文件分组：rule id 等宽 Pill + 单行截断 snippet（title 悬浮看全文，纯文本渲染）。
// shell 抄同目录 SkillInstallPreviewModal（Modal + ModalFooter / useI18n）；
// 视觉参照 PluginInstallDisclosure（警示图标、Pill），但不沾 capabilityPackage 信任模型。
// ============================================================================

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { SkillInstallCautionHit } from '@shared/contract/skillInstallCaution';
import { Modal, ModalFooter } from '../../../primitives';
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

/** 命中按文件分组，保持首次出现顺序 */
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
  const cautionText = t.settings.skills.caution;

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

        <div className="text-xs font-medium text-zinc-300">
          {interpolate(cautionText.hitsCount, { count: hits.length })}
        </div>

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
      </div>
    </Modal>
  );
};
