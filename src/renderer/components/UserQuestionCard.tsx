// ============================================================================
// UserQuestionCard —— AskUserQuestion 打断式选项卡（G2 拍板形态，2026-07-27）
//
// 模型调 AskUserQuestion 时，卡片占据 composer 位置（ChatView 里 ChatInput 被它
// 遮盖/替换显示），语义 = 必须先回答（或显式跳过）才能继续输入。不是消息流
// 内联卡，不是居中 Modal——全局 Modal（UserQuestionModal）形态已被本卡取代。
//
// 与权限卡的视觉区分必须成立：权限卡 = 安全语义琥珀/红（「我要动你的东西，
// 批不批」，带风险等级/记忆范围）；问题卡 = 中性询问语义蓝（「我需要你选一个
// 方向」），无风险语义、无授权记忆。
//
// 回答/跳过后：IPC USER_QUESTION_RESPONSE 回 host（round-trip 与旧 Modal
// 完全一致），卡片从 pending 队列清除、composer 恢复；问题与所选答案随
// AskUserQuestion 工具步骤落在消息流里（ToolCallDisplay 的 Q&A 记录块，可回看）。
// ============================================================================

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Check, HelpCircle } from 'lucide-react';
import type { UserQuestionRequest, UserQuestionResponse } from '@shared/contract';
import { IPC_CHANNELS } from '@shared/ipc';
import { useSessionStore } from '../stores/sessionStore';
import { Button } from './primitives/Button';
import { createLogger } from '../utils/logger';
import ipcService from '../services/ipcService';
import { useI18n } from '../hooks/useI18n';

const logger = createLogger('UserQuestionCard');

interface Props {
  request: UserQuestionRequest;
}

// 单选/多选项的选中指示圆点（不是按钮，故不走 primitives/Button）。
// 预设选项行与"其他"自由文本行共用，避免同一处手搓色散在两地。
const SelectionIndicator: React.FC<{ selected: boolean; multiSelect: boolean }> = ({
  selected,
  multiSelect,
}) => (
  <div
    className={`mt-0.5 w-4 h-4 rounded ${
      multiSelect ? 'rounded' : 'rounded-full'
    } border-2 flex items-center justify-center ${
      selected ? 'border-blue-500 bg-blue-500' : 'border-zinc-600'
    }`}
  >
    {selected && <Check className="w-3 h-3 text-white" />}
  </div>
);

export const UserQuestionCard: React.FC<Props> = ({ request }) => {
  const { t } = useI18n();
  const cardRef = useRef<HTMLDivElement>(null);
  // Store selected answers: header -> selected option label(s)
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  // "其他" 自由文本行：是否激活 + 当前输入值（按 header 维度）
  const [otherActive, setOtherActive] = useState<Record<string, boolean>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [declineReason, setDeclineReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Initialize answers
  useEffect(() => {
    const initial: Record<string, string | string[]> = {};
    request.questions.forEach((q) => {
      initial[q.header] = q.multiSelect ? [] : '';
    });
    setAnswers(initial);
    setOtherActive({});
    setOtherText({});
    setDeclineReason('');
    setSubmitting(false);
  }, [request]);

  // 卡片出现时接管焦点（同 PermissionCard 先例），键盘立即可用
  useEffect(() => {
    cardRef.current?.focus();
  }, [request.id]);

  const handleSelect = (header: string, label: string, multiSelect?: boolean) => {
    setOtherActive((prev) => ({ ...prev, [header]: false }));
    setAnswers((prev) => {
      if (multiSelect) {
        const current = prev[header] as string[];
        if (current.includes(label)) {
          return { ...prev, [header]: current.filter((l) => l !== label) };
        } else {
          return { ...prev, [header]: [...current, label] };
        }
      } else {
        return { ...prev, [header]: label };
      }
    });
  };

  // "其他" 行被选中/取消选中：单选=覆盖当前答案；多选=把自由文本加入/移出数组
  const handleToggleOther = (header: string, multiSelect?: boolean) => {
    const willActivate = !otherActive[header];
    setOtherActive((prev) => ({ ...prev, [header]: willActivate }));
    const text = otherText[header] ?? '';
    if (multiSelect) {
      setAnswers((prev) => {
        const current = (prev[header] as string[]).filter((l) => l !== text);
        return { ...prev, [header]: willActivate && text.trim() ? [...current, text] : current };
      });
    } else {
      setAnswers((prev) => ({ ...prev, [header]: willActivate ? text : '' }));
    }
  };

  // "其他" 输入框内容变化：仅当该行已激活才同步进 answers
  const handleOtherTextChange = (header: string, value: string, multiSelect?: boolean) => {
    const previousText = otherText[header] ?? '';
    setOtherText((prev) => ({ ...prev, [header]: value }));
    if (!otherActive[header]) return;
    if (multiSelect) {
      setAnswers((prev) => {
        const current = (prev[header] as string[]).filter((l) => l !== previousText);
        return { ...prev, [header]: value.trim() ? [...current, value] : current };
      });
    } else {
      setAnswers((prev) => ({ ...prev, [header]: value }));
    }
  };

  const isSelected = (header: string, label: string): boolean => {
    const answer = answers[header];
    if (Array.isArray(answer)) {
      return answer.includes(label);
    }
    return answer === label;
  };

  const canSubmit = (): boolean => {
    return request.questions.every((q) => {
      const answer = answers[q.header];
      if (Array.isArray(answer)) {
        return answer.length > 0;
      }
      return answer !== '';
    });
  };

  // 回答/跳过成功后才把卡片从 pending 队列清掉（composer 随之恢复）；
  // 失败保留卡片让用户重试，不静默丢问题。
  const respond = useCallback(
    async (response: UserQuestionResponse): Promise<void> => {
      if (submitting) return;
      setSubmitting(true);
      try {
        await ipcService.invoke(IPC_CHANNELS.USER_QUESTION_RESPONSE, response);
        useSessionStore.getState().clearPendingUserQuestion(request);
      } catch (error) {
        logger.error('Failed to send user question response', error);
        setSubmitting(false);
      }
    },
    [request, submitting],
  );

  const handleSubmit = () => {
    if (!canSubmit()) return;
    void respond({ requestId: request.id, answers });
  };

  const handleSkip = useCallback(() => {
    const trimmedReason = declineReason.trim();
    void respond({
      requestId: request.id,
      declined: true,
      ...(trimmedReason ? { reason: trimmedReason } : {}),
    });
  }, [respond, request.id, declineReason]);

  // Esc = 显式跳过（与权限卡 Esc=拒绝 同族）；stopPropagation 防触发 ChatView 的 Esc+Esc
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleSkip();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleSkip]);

  return (
    <div className="w-full px-4 animate-slideUp" data-testid="user-question-card">
      <div
        ref={cardRef}
        tabIndex={-1}
        className="w-full max-w-3xl mx-auto bg-zinc-900 rounded-lg shadow-2xl border-2 border-blue-500/60 outline-hidden"
      >
        {/* 头部：中性询问语义（蓝），与权限卡的琥珀/红安全语义拉开 */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800 bg-blue-500/10 rounded-t-lg">
          <HelpCircle className="w-4 h-4 text-blue-400 shrink-0" />
          <span className="text-sm font-medium text-blue-300">{t.userQuestion.title}</span>
        </div>

        {/* Questions */}
        <div className="space-y-5 max-h-[50vh] overflow-y-auto px-4 py-3">
          {request.questions.map((q, qIndex) => (
            <div key={qIndex} className="space-y-2">
              <div>
                <span className="inline-block px-2 py-0.5 text-xs font-medium rounded bg-zinc-700 text-zinc-400 mb-1.5">
                  {q.header}
                </span>
                <p className="text-sm text-zinc-200">{q.question}</p>
                {q.multiSelect && (
                  <p className="text-xs text-zinc-500 mt-1">{t.userQuestion.multiSelectHint}</p>
                )}
              </div>

              <div className="space-y-2">
                {q.options.map((option, oIndex) => (
                  <button
                    key={oIndex}
                    onClick={() => handleSelect(q.header, option.label, q.multiSelect)}
                    className={`w-full p-2.5 rounded-lg border text-left transition-all ${
                      isSelected(q.header, option.label)
                        ? 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/50'
                        : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <SelectionIndicator
                        selected={isSelected(q.header, option.label)}
                        multiSelect={!!q.multiSelect}
                      />
                      <div className="flex-1">
                        <div className="font-medium text-zinc-200 text-sm">
                          {option.label}
                        </div>
                        {option.description && (
                          <p className="text-xs text-zinc-400 mt-0.5">
                            {option.description}
                          </p>
                        )}
                      </div>
                    </div>
                  </button>
                ))}

                {/* "其他" 自由文本行：选中即可直接输入，不用先选再改 */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => handleToggleOther(q.header, q.multiSelect)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleToggleOther(q.header, q.multiSelect);
                    }
                  }}
                  className={`w-full p-2.5 rounded-lg border text-left transition-all cursor-pointer ${
                    otherActive[q.header]
                      ? 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/50'
                      : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <SelectionIndicator
                      selected={!!otherActive[q.header]}
                      multiSelect={!!q.multiSelect}
                    />
                    <div className="flex-1">
                      <div className="font-medium text-zinc-200 text-sm">{t.userQuestion.other}</div>
                      {otherActive[q.header] && (
                        <input
                          type="text"
                          autoFocus
                          value={otherText[q.header] ?? ''}
                          onChange={(e) => handleOtherTextChange(q.header, e.target.value, q.multiSelect)}
                          onClick={(e) => e.stopPropagation()}
                          placeholder={t.userQuestion.otherPlaceholder}
                          className="mt-2 w-full px-2 py-1.5 text-sm bg-zinc-800 border border-zinc-600 rounded text-zinc-200 placeholder-zinc-500 focus:outline-hidden focus:border-blue-500"
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* 底部：跳过原因（可选）+ 动作行 */}
        <div className="px-4 pb-3">
          <input
            type="text"
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            placeholder={t.userQuestion.declineReasonPlaceholder}
            aria-label={t.userQuestion.declineReasonLabel}
            className="w-full px-2 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-200 placeholder-zinc-500 focus:outline-hidden focus:border-blue-500"
          />
          <div className="mt-2.5 flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleSkip}
              disabled={submitting}
            >
              {t.userQuestion.skip}
            </Button>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={!canSubmit() || submitting}
            >
              {t.userQuestion.submit}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UserQuestionCard;
