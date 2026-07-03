// ============================================================================
// SoulSettings - 自定义 Agent 人格（SOUL.md）
// 编辑用户级全局人格，替换内置身份核心块；安全红线始终保留，不受此处影响。
// 后端：domain:soul（getStatus / getProfile / getDefault / saveProfile / resetProfile）
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { Fingerprint, Save, RotateCcw, FileText, ShieldCheck, Loader2, Check } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import { createLogger } from '../../../../utils/logger';
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';

const logger = createLogger('SoulSettings');

// ----------------------------------------------------------------------------
// Types（对齐 soul.ipc.ts 各 action 的 data 形状）
// ----------------------------------------------------------------------------

interface SoulStatus {
  source: 'project' | 'user' | 'builtin';
  length: number;
}
interface SoulProfile {
  content: string;
  filePath: string;
}
interface SoulDefault {
  content: string;
}

const USER_SCOPE = { scope: 'user' as const };

// ============================================================================
// Component
// ============================================================================

export const SoulSettings: React.FC = () => {
  const { t } = useI18n();
  const soulText = t.settings.soul;
  const [content, setContent] = useState('');
  const [baseline, setBaseline] = useState('');       // 已保存/已加载基线，用于判断是否 dirty
  const [defaultContent, setDefaultContent] = useState('');
  const [source, setSource] = useState<SoulStatus['source']>('builtin');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);   // 保存成功后短暂高亮
  const [error, setError] = useState<string | null>(null);

  const isCustom = source === 'user';
  const isDirty = content !== baseline;

  // 首次加载：状态 + 当前内容 + 内置默认。未自定义时预填默认作为安全的起改基线。
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [status, profile, def] = await Promise.all([
          ipcService.invokeDomain<SoulStatus>(IPC_DOMAINS.SOUL, 'getStatus'),
          ipcService.invokeDomain<SoulProfile>(IPC_DOMAINS.SOUL, 'getProfile', USER_SCOPE),
          ipcService.invokeDomain<SoulDefault>(IPC_DOMAINS.SOUL, 'getDefault'),
        ]);
        if (cancelled) return;
        setSource(status.source);
        setDefaultContent(def.content);
        const initial = profile.content.trim() ? profile.content : def.content;
        setContent(initial);
        setBaseline(initial);
      } catch (err) {
        if (cancelled) return;
        logger.error('Failed to load soul', err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SOUL, 'saveProfile', { ...USER_SCOPE, content });
      const status = await ipcService.invokeDomain<SoulStatus>(IPC_DOMAINS.SOUL, 'getStatus');
      setSource(status.source);
      setBaseline(content);
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 2000);
      logger.info('Soul saved', { length: content.length });
    } catch (err) {
      logger.error('Failed to save soul', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [content]);

  const handleReset = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SOUL, 'resetProfile', USER_SCOPE);
      const status = await ipcService.invokeDomain<SoulStatus>(IPC_DOMAINS.SOUL, 'getStatus');
      setSource(status.source);
      setContent(defaultContent);
      setBaseline(defaultContent);
      logger.info('Soul reset to default');
    } catch (err) {
      logger.error('Failed to reset soul', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [defaultContent]);

  // 把编辑器内容替换为内置默认模板（不立即保存，需点保存才落盘）
  const handleLoadDefault = useCallback(() => {
    setContent(defaultContent);
  }, [defaultContent]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        {soulText.loading}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 头部说明 + 来源徽章 */}
      <div>
        <div className="flex items-center gap-2">
          <Fingerprint className="h-4 w-4 text-primary-400" />
          <h3 className="text-sm font-medium text-zinc-200">{soulText.title}</h3>
          <span
            className={`ml-1 rounded-full px-2 py-0.5 text-xs ${
              isCustom
                ? 'bg-primary-500/20 text-primary-400'
                : 'bg-zinc-700 text-zinc-400'
            }`}
          >
            {isCustom ? soulText.customBadge : soulText.builtinBadge}
          </span>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          {soulText.description}
        </p>
      </div>

      {/* 安全说明 —— 拆分后安全红线始终生效 */}
      <div className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
        <p className="text-xs text-zinc-400">
          {soulText.safetyPrefix}<span className="text-zinc-200">{soulText.safetyStrong}</span>{soulText.safetySuffix}
        </p>
      </div>

      {/* 编辑器 */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <label htmlFor="soul-editor" className="text-xs font-medium text-zinc-400">
            {soulText.contentLabel}
          </label>
          <span className="text-xs text-zinc-600">{content.length}{soulText.charSuffix}</span>
        </div>
        <textarea
          id="soul-editor"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          rows={14}
          placeholder={soulText.placeholder}
          className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 font-mono text-sm leading-relaxed text-zinc-200 outline-none transition-colors focus:border-zinc-500 focus:ring-1 focus:ring-white/10"
        />
      </div>

      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-400">
          {soulText.errorPrefix}{error}
        </div>
      )}

      {/* 操作区 */}
      <div className="flex items-center gap-3 pt-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !isDirty}
          className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            saving || !isDirty
              ? 'cursor-not-allowed bg-zinc-800 text-zinc-500'
              : 'bg-primary-500 text-white hover:bg-primary-600'
          }`}
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : savedTick ? (
            <Check className="h-4 w-4" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {savedTick ? t.common.saved : t.common.save}
        </button>

        <button
          type="button"
          onClick={handleLoadDefault}
          disabled={saving || content === defaultContent}
          className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FileText className="h-4 w-4" />
          {soulText.loadDefault}
        </button>

        <button
          type="button"
          onClick={handleReset}
          disabled={saving || !isCustom}
          className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
          title={isCustom ? soulText.resetCustomTitle : soulText.resetDefaultTitle}
        >
          <RotateCcw className="h-4 w-4" />
          {soulText.reset}
        </button>
      </div>
    </div>
  );
};
