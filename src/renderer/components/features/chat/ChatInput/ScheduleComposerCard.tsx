// ============================================================================
// ScheduleComposerCard - /schedule 不带参数时的对话式创建卡片
//
// 两种入口合一：
//   - 模板库：每日简报 / 缺陷扫描 / 周回顾，点选→填空→创建
//   - 自定义：自由文本描述
// 创建统一回调 onSubmit(description)，由 ChatInput 走 cron:generateFromPrompt → createJob。
// ============================================================================

import React, { useState } from 'react';
import { Clock3, X, Loader2, ChevronLeft } from 'lucide-react';
import {
  SCHEDULE_TEMPLATES,
  CUSTOM_TEMPLATE_ID,
  initTemplateValues,
  type ScheduleTemplate,
} from './scheduleTemplates';

interface ScheduleComposerCardProps {
  creating: boolean;
  onSubmit: (description: string) => void;
  onDismiss: () => void;
}

export const ScheduleComposerCard: React.FC<ScheduleComposerCardProps> = ({
  creating,
  onSubmit,
  onDismiss,
}) => {
  const [selected, setSelected] = useState<ScheduleTemplate | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  const pickTemplate = (template: ScheduleTemplate) => {
    setSelected(template);
    setValues(initTemplateValues(template));
  };

  const composed = selected ? selected.compose(values).trim() : '';
  const canCreate = composed.length > 0 && !creating;

  return (
    <div
      data-schedule-composer
      className="mb-2 px-3 py-3 bg-indigo-500/10 border border-indigo-500/20 rounded-lg animate-fadeIn"
    >
      <div className="flex items-start gap-2">
        <Clock3 className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-indigo-300">创建定时任务</div>
          <div className="mt-0.5 text-[11px] text-indigo-200/60 leading-relaxed">
            定时任务会按你设定的时间在后台自动跑一个 agent，跑完发通知、点通知能跳到结果会话。
            选个模板填空，或自己描述「做什么、什么时候跑」。
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="p-0.5 text-zinc-500 hover:text-zinc-300 transition-colors"
          title="取消"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {!selected ? (
        // 第一步：模板选择
        <div className="mt-2.5 grid grid-cols-2 gap-1.5">
          {SCHEDULE_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              data-schedule-template={template.id}
              onClick={() => pickTemplate(template)}
              className="flex items-center gap-2 px-2.5 py-2 text-left bg-indigo-500/5 border border-indigo-500/20 rounded-md hover:bg-indigo-500/15 transition-colors"
            >
              <span className="text-base leading-none">{template.emoji}</span>
              <span className="min-w-0">
                <span className="block text-xs text-indigo-200 truncate">{template.name}</span>
                <span className="block text-[10px] text-indigo-200/50 truncate">{template.blurb}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        // 第二步：填空 + 创建
        <div className="mt-2.5 space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] text-indigo-200/70">
            <span className="text-sm leading-none">{selected.emoji}</span>
            <span>{selected.name}</span>
          </div>

          {selected.fields.map((field) => (
            <label key={field.key} className="block">
              <span className="block mb-1 text-[10px] text-indigo-200/50">{field.label}</span>
              {field.multiline ? (
                <textarea
                  data-schedule-field={field.key}
                  value={values[field.key] ?? ''}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  placeholder={field.placeholder}
                  rows={2}
                  className="w-full bg-zinc-800 border border-indigo-500/30 rounded px-2 py-1 text-xs text-zinc-200 outline-hidden focus:border-indigo-500/50 resize-none"
                  autoFocus
                />
              ) : (
                <input
                  type="text"
                  data-schedule-field={field.key}
                  value={values[field.key] ?? ''}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  placeholder={field.placeholder}
                  className="w-full bg-zinc-800 border border-indigo-500/30 rounded px-2 py-1 text-xs text-zinc-200 outline-hidden focus:border-indigo-500/50"
                />
              )}
            </label>
          ))}

          {/* 预览将要创建的自然语言描述（自定义模式下即用户原文，不重复展示） */}
          {selected.id !== CUSTOM_TEMPLATE_ID && composed && (
            <div className="text-[10px] text-indigo-200/40 leading-relaxed">将创建：{composed}</div>
          )}

          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={() => setSelected(null)}
              disabled={creating}
              className="flex items-center gap-1 px-2 py-1 text-[11px] text-indigo-200/60 hover:text-indigo-200 transition-colors disabled:opacity-50"
            >
              <ChevronLeft className="w-3 h-3" />
              换模板
            </button>
            <div className="flex-1" />
            <button
              type="button"
              data-schedule-create
              onClick={() => canCreate && onSubmit(composed)}
              disabled={!canCreate}
              className="flex items-center gap-1 px-3 py-1 text-xs bg-indigo-500/20 text-indigo-200 rounded hover:bg-indigo-500/30 transition-colors disabled:opacity-50"
            >
              {creating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Clock3 className="w-3 h-3" />}
              创建定时任务
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
