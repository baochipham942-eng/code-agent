// ============================================================================
// SkillInstallPreviewModal - 自定义库装前预览弹窗
// staged 三段式安装的中间态：stage 成功后展示仓库将注入模型上下文的全部
// SKILL.md 内容，确认（confirm）才落库；任何方式关闭都触发 cancel，不留孤儿
// staging。
// ============================================================================

import React, { Suspense, lazy, useCallback, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, ShieldAlert, X } from 'lucide-react';
import { Modal, ModalFooter } from '../../../primitives';
import { SKILL_CHANNELS } from '@shared/ipc/channels';
import type { StageRepositoryResult } from '@shared/contract/skillRepository';
import { useI18n } from '../../../../hooks/useI18n';
import { createLogger } from '../../../../utils/logger';
import { invokeSkillIPC } from '../../../../services/invokeSkillIPC';

const logger = createLogger('SkillInstallPreviewModal');

// 懒加载 markdown 渲染链（react-markdown + remark/rehype），同 CaptureDetail 的做法，
// 不进首屏 modulepreload；只有真正展开查看 SKILL.md 时才下载。
const MarkdownCore = lazy(() => import('../../chat/MessageBubble/MarkdownCore'));

/**
 * 剥掉 SKILL.md 头部 frontmatter（`---` 包围的 YAML 块）。
 * name/description 已在卡片头部展示，frontmatter 不进入 markdown 渲染正文。
 */
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? content.slice(match[0].length) : content;
}

interface SkillInstallPreviewModalProps {
  /** stage 成功的结果（success=true 且带 stageId） */
  result: StageRepositoryResult;
  /** 取消/关闭后回调（cancel IPC 已在本组件内触发） */
  onCancel: () => void;
  /** 确认安装成功后回调（父组件负责刷新列表与提示） */
  onInstalled: (repoName: string) => void;
}

export const SkillInstallPreviewModal: React.FC<SkillInstallPreviewModalProps> = ({
  result,
  onCancel,
  onInstalled,
}) => {
  const { t } = useI18n();
  const previewText = t.settings.skills.preview;
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  // confirm 成功后 staging 已被 host 落库移除，关闭时不能再 cancel
  const settledRef = useRef(false);

  const stageId = result.stageId || '';
  const repoName = result.repoName || result.repoId || '';
  const skills = result.skills || [];
  const warnings = result.warnings || [];
  const sourceLabel =
    result.sourceType === 'modelscope' ? previewText.sourceModelscope : previewText.sourceGithub;
  const layoutLabel =
    result.layout === 'single-skill'
      ? previewText.layoutSingle
      : `${previewText.layoutLibraryPrefix}${skills.length}${previewText.layoutLibrarySuffix}`;

  // 任何关闭路径（取消按钮 / ESC / 遮罩 / 头部 X）都汇聚到这里，保证触发 cancel
  const handleClose = useCallback(() => {
    if (!settledRef.current && stageId) {
      settledRef.current = true;
      void invokeSkillIPC(SKILL_CHANNELS.REPO_CANCEL, stageId).catch((err: unknown) => {
        logger.warn('Failed to cancel staged repository', { error: err });
      });
    }
    onCancel();
  }, [onCancel, stageId]);

  const handleConfirm = useCallback(async () => {
    if (confirming) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const confirmResult = await invokeSkillIPC(SKILL_CHANNELS.REPO_CONFIRM, stageId);
      if (confirmResult?.success) {
        settledRef.current = true;
        onInstalled(repoName);
      } else {
        setConfirmError(confirmResult?.error || previewText.confirmFailed);
      }
    } catch (err) {
      logger.error('Failed to confirm staged repository', err);
      setConfirmError(previewText.confirmFailed);
    } finally {
      setConfirming(false);
    }
  }, [confirming, stageId, repoName, onInstalled, previewText.confirmFailed]);

  const toggleSkill = (name: string) => {
    setExpandedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  return (
    <Modal
      isOpen
      onClose={handleClose}
      size="full"
      header={
        <>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-zinc-200">{repoName}</h2>
              <span className="shrink-0 rounded border border-indigo-500/20 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] text-indigo-300">
                {sourceLabel}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-zinc-400">{layoutLabel}</p>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
            aria-label={t.common.close}
          >
            <X className="w-5 h-5" />
          </button>
        </>
      }
      footer={
        <ModalFooter
          cancelText={t.common.cancel}
          confirmText={confirming ? previewText.confirming : previewText.confirmInstall}
          onCancel={handleClose}
          onConfirm={handleConfirm}
          confirmDisabled={confirming}
          confirmColorClass="bg-indigo-600 hover:bg-indigo-500"
        />
      }
    >
      <div className="space-y-4">
        {/* 安全提示：skill 内容将注入模型上下文 */}
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{previewText.safetyNotice}</span>
        </div>

        {/* stage 警告 */}
        {warnings.length > 0 && (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" />
              {previewText.warningsTitle}
            </div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-amber-200/80">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}

        {/* skill 列表：name + description，可展开看 SKILL.md 全文 */}
        <div className="space-y-2">
          {skills.map((skill) => {
            const expanded = expandedSkills.has(skill.name);
            return (
              <div key={skill.name} className="rounded-lg border border-zinc-700 bg-zinc-800">
                <button
                  type="button"
                  onClick={() => toggleSkill(skill.name)}
                  aria-expanded={expanded}
                  className="flex w-full items-start gap-2 px-3 py-2.5 text-left"
                >
                  {expanded ? (
                    <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
                  ) : (
                    <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-zinc-200">
                      {skill.name}
                    </span>
                    {skill.description && (
                      <span className="mt-0.5 block text-xs leading-relaxed text-zinc-400">
                        {skill.description}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-[11px] text-indigo-400">
                    {expanded ? previewText.hideContent : previewText.viewContent}
                  </span>
                </button>
                {expanded && (
                  <div className="mx-3 mb-3 max-h-96 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-3">
                    <div className="prose prose-invert prose-sm max-w-none text-sm leading-relaxed text-zinc-300">
                      <Suspense
                        fallback={
                          <div className="whitespace-pre-wrap break-words text-xs text-zinc-400">
                            {stripFrontmatter(skill.skillMdContent)}
                          </div>
                        }
                      >
                        <MarkdownCore content={stripFrontmatter(skill.skillMdContent)} />
                      </Suspense>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* confirm 失败：弹窗内展示，不静默 */}
        {confirmError && (
          <div className="flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {confirmError}
          </div>
        )}
      </div>
    </Modal>
  );
};
