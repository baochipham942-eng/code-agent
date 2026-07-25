// ============================================================================
// UserQuestionModal - Display questions from ask_user_question tool
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Check, HelpCircle } from 'lucide-react';
import type { UserQuestionRequest, UserQuestionResponse } from '@shared/contract';
import { IPC_CHANNELS } from '@shared/ipc';
import { Modal, ModalFooter } from './primitives/Modal';
import { createLogger } from '../utils/logger';
import ipcService from '../services/ipcService';
import { useI18n } from '../hooks/useI18n';

const logger = createLogger('UserQuestionModal');

interface Props {
  request: UserQuestionRequest;
  onClose: () => void;
}

export const UserQuestionModal: React.FC<Props> = ({ request, onClose }) => {
  const { t } = useI18n();
  // Store selected answers: header -> selected option label(s)
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  // "其他" 自由文本行：是否激活 + 当前输入值（按 header 维度）
  const [otherActive, setOtherActive] = useState<Record<string, boolean>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [declineReason, setDeclineReason] = useState('');

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
  }, [request]);

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

  const handleSubmit = async () => {
    if (!canSubmit()) return;

    const response: UserQuestionResponse = {
      requestId: request.id,
      answers,
    };

    try {
      await ipcService.invoke(IPC_CHANNELS.USER_QUESTION_RESPONSE, response);
      onClose();
    } catch (error) {
      logger.error('Failed to submit response', error);
    }
  };

  const handleDismiss = async () => {
    const trimmedReason = declineReason.trim();
    const response: UserQuestionResponse = {
      requestId: request.id,
      declined: true,
      ...(trimmedReason ? { reason: trimmedReason } : {}),
    };

    try {
      await ipcService.invoke(IPC_CHANNELS.USER_QUESTION_RESPONSE, response);
      onClose();
    } catch (error) {
      logger.error('Failed to decline response', error);
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={handleDismiss}
      size="lg"
      title="Agent 需要您的输入"
      headerBgClass="bg-blue-500/10"
      headerIcon={<HelpCircle className="w-5 h-5 text-blue-400" />}
      footer={
        <ModalFooter
          cancelText="取消"
          confirmText="提交回答"
          onCancel={handleDismiss}
          onConfirm={handleSubmit}
          confirmDisabled={!canSubmit()}
        />
      }
    >
      {/* Questions */}
      <div className="space-y-6 max-h-[60vh] overflow-y-auto -mx-6 px-6">
        {request.questions.map((q, qIndex) => (
          <div key={qIndex} className="space-y-3">
            <div>
              <span className="inline-block px-2 py-0.5 text-xs font-medium rounded bg-zinc-700 text-zinc-400 mb-2">
                {q.header}
              </span>
              <p className="text-sm text-zinc-200">{q.question}</p>
              {q.multiSelect && (
                <p className="text-xs text-zinc-500 mt-1">可多选</p>
              )}
            </div>

            <div className="space-y-2">
              {q.options.map((option, oIndex) => (
                <button
                  key={oIndex}
                  onClick={() => handleSelect(q.header, option.label, q.multiSelect)}
                  className={`w-full p-3 rounded-lg border text-left transition-all ${
                    isSelected(q.header, option.label)
                      ? 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/50'
                      : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`mt-0.5 w-4 h-4 rounded ${
                        q.multiSelect ? 'rounded' : 'rounded-full'
                      } border-2 flex items-center justify-center ${
                        isSelected(q.header, option.label)
                          ? 'border-blue-500 bg-blue-500'
                          : 'border-zinc-600'
                      }`}
                    >
                      {isSelected(q.header, option.label) && (
                        <Check className="w-3 h-3 text-white" />
                      )}
                    </div>
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
                className={`w-full p-3 rounded-lg border text-left transition-all cursor-pointer ${
                  otherActive[q.header]
                    ? 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/50'
                    : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`mt-0.5 w-4 h-4 rounded ${
                      q.multiSelect ? 'rounded' : 'rounded-full'
                    } border-2 flex items-center justify-center ${
                      otherActive[q.header] ? 'border-blue-500 bg-blue-500' : 'border-zinc-600'
                    }`}
                  >
                    {otherActive[q.header] && <Check className="w-3 h-3 text-white" />}
                  </div>
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

      {/* 取消原因：可选，随 declined 响应一并透传给模型 */}
      <div className="mt-4 -mx-6 px-6">
        <label className="block text-xs text-zinc-500 mb-1">{t.userQuestion.declineReasonLabel}</label>
        <input
          type="text"
          value={declineReason}
          onChange={(e) => setDeclineReason(e.target.value)}
          placeholder={t.userQuestion.declineReasonPlaceholder}
          className="w-full px-2 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-200 placeholder-zinc-500 focus:outline-hidden focus:border-blue-500"
        />
      </div>
    </Modal>
  );
};
