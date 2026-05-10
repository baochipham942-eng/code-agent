// ============================================================================
// PromptManagerModal - 提示词管理（查看 + override）
// ============================================================================
// 左侧按 category 分组列出所有 prompt（带 override 状态徽标）；
// 右侧详情：默认文本 readonly + override 编辑区 + 保存 / 恢复默认 / 复制。
// ============================================================================

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { X, RotateCcw, Save, Copy, Check } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { IPC_DOMAINS } from '@shared/ipc';
import { IconButton } from '../../primitives';
import { createLogger } from '../../../utils/logger';

const logger = createLogger('PromptManagerModal');

interface PromptListItem {
  id: string;
  category: string;
  name: string;
  description?: string;
  overridden: boolean;
}

interface PromptDetail extends PromptListItem {
  defaultText: string;
  override: string | null;
}

async function invokePrompt<T>(action: string, payload?: unknown): Promise<T> {
  const response = await window.domainAPI?.invoke<T>(IPC_DOMAINS.PROMPT, action, payload);
  if (!response?.success) {
    throw new Error(response?.error?.message || `Prompt action failed: ${action}`);
  }
  return response.data as T;
}

export const PromptManagerModal: React.FC = () => {
  const showPromptManager = useAppStore((s) => s.showPromptManager);
  const setShowPromptManager = useAppStore((s) => s.setShowPromptManager);

  const [list, setList] = useState<PromptListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PromptDetail | null>(null);
  const [editText, setEditText] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<'default' | 'override' | null>(null);

  // 加载列表
  useEffect(() => {
    if (!showPromptManager) return;
    setLoading(true);
    invokePrompt<PromptListItem[]>('list')
      .then((items) => {
        setList(items || []);
        if (!selectedId && items?.length) setSelectedId(items[0].id);
      })
      .catch((err) => logger.error('Failed to load prompt list', err))
      .finally(() => setLoading(false));
  }, [showPromptManager, selectedId]);

  // 加载详情
  useEffect(() => {
    if (!selectedId || !showPromptManager) {
      setDetail(null);
      return;
    }
    invokePrompt<PromptDetail>('get', { id: selectedId })
      .then((d) => {
        setDetail(d);
        setEditText(d?.override ?? d?.defaultText ?? '');
      })
      .catch((err) => logger.error('Failed to load prompt detail', err));
  }, [selectedId, showPromptManager]);

  // 按 category 分组
  const grouped = useMemo(() => {
    const map = new Map<string, PromptListItem[]>();
    for (const item of list) {
      const arr = map.get(item.category) ?? [];
      arr.push(item);
      map.set(item.category, arr);
    }
    return Array.from(map.entries());
  }, [list]);

  const dirty = detail !== null && editText !== (detail.override ?? detail.defaultText);

  const handleSave = useCallback(async () => {
    if (!detail || !dirty) return;
    setSaving(true);
    try {
      const updated = await invokePrompt<PromptDetail>('set', { id: detail.id, text: editText });
      setDetail(updated);
      setList((prev) => prev.map((p) => (p.id === detail.id ? { ...p, overridden: true } : p)));
    } catch (err) {
      logger.error('Failed to save prompt override', err);
    } finally {
      setSaving(false);
    }
  }, [detail, dirty, editText]);

  const handleReset = useCallback(async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const updated = await invokePrompt<PromptDetail>('reset', { id: detail.id });
      setDetail(updated);
      setEditText(updated?.defaultText ?? '');
      setList((prev) => prev.map((p) => (p.id === detail.id ? { ...p, overridden: false } : p)));
    } catch (err) {
      logger.error('Failed to reset prompt', err);
    } finally {
      setSaving(false);
    }
  }, [detail]);

  const handleCopy = useCallback(async (kind: 'default' | 'override') => {
    if (!detail) return;
    const text = kind === 'default' ? detail.defaultText : editText;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1200);
    } catch (err) {
      logger.warn('Failed to copy', { err });
    }
  }, [detail, editText]);

  if (!showPromptManager) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setShowPromptManager(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-manager-title"
        className="relative w-full max-w-5xl h-[88vh] bg-zinc-900 rounded-xl border border-zinc-700 shadow-2xl overflow-hidden animate-fadeIn flex flex-col"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-700 flex-shrink-0">
          <h2 id="prompt-manager-title" className="text-lg font-semibold text-zinc-200">
            提示词
          </h2>
          <IconButton
            icon={<X className="w-5 h-5" />}
            aria-label="关闭"
            onClick={() => setShowPromptManager(false)}
            variant="default"
            size="md"
          />
        </div>

        <div className="flex flex-1 min-h-0">
          {/* 左侧分类列表 */}
          <div className="w-64 border-r border-zinc-700 overflow-y-auto p-2">
            {loading && list.length === 0 ? (
              <div className="px-3 py-2 text-xs text-zinc-500">加载中…</div>
            ) : grouped.length === 0 ? (
              <div className="px-3 py-2 text-xs text-zinc-500">暂无已注册的 prompt</div>
            ) : (
              grouped.map(([category, items]) => (
                <div key={category} className="space-y-1 mb-3">
                  <div className="px-3 text-[11px] font-medium text-zinc-500 uppercase tracking-wider">
                    {category}
                  </div>
                  {items.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => setSelectedId(item.id)}
                      className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors ${
                        selectedId === item.id
                          ? 'bg-zinc-700 text-zinc-200'
                          : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                      }`}
                    >
                      <span className="text-sm flex-1 truncate" title={item.name}>{item.name}</span>
                      {item.overridden && (
                        <span
                          className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0"
                          title="已自定义"
                        />
                      )}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>

          {/* 右侧详情 */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {!detail ? (
              <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
                选择左侧一个提示词查看
              </div>
            ) : (
              <>
                <div className="px-6 py-4 border-b border-zinc-700 flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="text-base font-semibold text-zinc-200 truncate">{detail.name}</div>
                    <div className="text-xs text-zinc-500 mt-0.5 truncate" title={detail.id}>
                      {detail.category} · {detail.id}
                    </div>
                    {detail.description && (
                      <div className="text-xs text-zinc-400 mt-1">{detail.description}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {detail.overridden && (
                      <span className="text-xs px-2 py-1 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
                        已自定义
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex-1 grid grid-cols-2 gap-4 p-6 overflow-hidden">
                  {/* 默认文本 */}
                  <div className="flex flex-col min-h-0">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-zinc-400">默认</span>
                      <button
                        type="button"
                        onClick={() => handleCopy('default')}
                        className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
                      >
                        {copied === 'default' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                        复制
                      </button>
                    </div>
                    <textarea
                      readOnly
                      value={detail.defaultText}
                      className="flex-1 min-h-0 w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs font-mono text-zinc-400 resize-none focus:outline-none"
                    />
                  </div>

                  {/* Override 编辑 */}
                  <div className="flex flex-col min-h-0">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-zinc-400">
                        当前生效 {dirty && <span className="text-amber-400 ml-1">·  未保存</span>}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopy('override')}
                        className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
                      >
                        {copied === 'override' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                        复制
                      </button>
                    </div>
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      spellCheck={false}
                      className="flex-1 min-h-0 w-full bg-zinc-900 border border-zinc-700 rounded-lg p-3 text-xs font-mono text-zinc-200 resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between gap-4 px-6 py-3 border-t border-zinc-700 bg-zinc-900/60 flex-shrink-0">
                  <div className="text-xs text-zinc-500 flex-1 min-w-0 truncate" title={`保存到 ~/.code-agent/prompts-overrides/${detail.id}.md，下一轮对话立即生效`}>
                    保存到 <code className="text-zinc-400">~/.code-agent/prompts-overrides/{detail.id}.md</code> · 下一轮对话立即生效
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      type="button"
                      onClick={handleReset}
                      disabled={!detail.overridden || saving}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-zinc-300 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      恢复默认
                    </button>
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={!dirty || saving}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                    >
                      <Save className="w-3.5 h-3.5" />
                      {saving ? '保存中…' : '保存'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
