// ============================================================================
// UserQuestionModal - Display questions from ask_user_question tool
// ============================================================================

import React, { useState, useEffect } from 'react';
import { X, Check, HelpCircle } from 'lucide-react';
import type { UserQuestionRequest, UserQuestionResponse } from '@shared/types';
import { IPC_CHANNELS } from '@shared/ipc';

interface Props {
  request: UserQuestionRequest;
  onClose: () => void;
}

export const UserQuestionModal: React.FC<Props> = ({ request, onClose }) => {
  // Store selected answers: header -> selected option label(s)
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});

  // Initialize answers
  useEffect(() => {
    const initial: Record<string, string | string[]> = {};
    request.questions.forEach((q) => {
      initial[q.header] = q.multiSelect ? [] : '';
    });
    setAnswers(initial);
  }, [request]);

  const handleSelect = (header: string, label: string, multiSelect?: boolean) => {
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
      await window.electronAPI?.invoke(IPC_CHANNELS.USER_QUESTION_RESPONSE, response);
      onClose();
    } catch (error) {
      console.error('Failed to submit response:', error);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div className="relative w-full max-w-lg bg-zinc-900 rounded-xl border border-zinc-800 shadow-2xl overflow-hidden animate-fadeIn">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-zinc-800 bg-blue-500/10">
          <HelpCircle className="w-5 h-5 text-blue-400" />
          <h2 className="text-lg font-semibold text-zinc-100">Agent 需要您的输入</h2>
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Questions */}
        <div className="p-6 space-y-6 max-h-[60vh] overflow-y-auto">
          {request.questions.map((q, qIndex) => (
            <div key={qIndex} className="space-y-3">
              <div>
                <span className="inline-block px-2 py-0.5 text-xs font-medium rounded bg-zinc-800 text-zinc-400 mb-2">
                  {q.header}
                </span>
                <p className="text-sm text-zinc-100">{q.question}</p>
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
                        : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800/50'
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
                        <div className="font-medium text-zinc-100 text-sm">
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
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-zinc-800 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit()}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              canSubmit()
                ? 'bg-blue-500 text-white hover:bg-blue-600'
                : 'bg-zinc-700 text-zinc-500 cursor-not-allowed'
            }`}
          >
            提交回答
          </button>
        </div>
      </div>
    </div>
  );
};
