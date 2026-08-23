// ============================================================================
// RolePersonalizationTab - 专家详情「个性化」页
// ============================================================================
// 三段可编辑正文，用分段芯片切换：
//   我是谁     ← agent 定义正文（沿用原人设编辑器，父级传进来）
//   你的期望   ← roles/<id>/USER.md
//   行为准则   ← roles/<id>/SOUL.md
// 后两段由本组件直接读写；两者都会拼进这位专家的 system prompt。
//
// 「常驻边界」不是第四段正文，而是常驻在分段芯片上方的硬约束块：它由系统强制执行
// （勾上就把对外发送工具从工具表里摘掉），与三段正文是两回事。放在段里会让人以为
// 「在行为准则里写一句不发送」也能拦住——那正是 K2 续工要治的病。

import React, { useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { RolePanelDetail } from '@shared/contract/roleAssets';
import ipcService from '../../../services/ipcService';
import { useI18n } from '../../../hooks/useI18n';
import { SettingsSection } from '../settings/SettingsLayout';

type Segment = 'identity' | 'expectation' | 'soul';
const SEGMENTS: readonly Segment[] = ['identity', 'expectation', 'soul'];

/** 只提交改动的那一段，避免另一段被同屏的旧值覆盖。 */
async function savePersonalization(roleId: string, patch: {
  userExpectation?: string;
  soul?: string;
  boundaries?: { disallowExternalSending: boolean };
}): Promise<void> {
  await ipcService.invokeDomain(IPC_DOMAINS.ROLES, 'updatePersonalization', { roleId, ...patch });
}

/**
 * 初值只取一次 + 父级按 roleId 重挂载：外部刷新不会冲掉正在编辑的内容。
 */
const ProseEditor: React.FC<{
  segment: Exclude<Segment, 'identity'>;
  roleId: string;
  initial: string;
  onSaved: () => void;
}> = ({ segment, roleId, initial, onSaved }) => {
  const { t } = useI18n();
  const text = t.expert.rolePersonalization;
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await savePersonalization(roleId, segment === 'expectation' ? { userExpectation: value } : { soul: value });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection title={text.segments[segment].title} description={text.segments[segment].description}>
      <div className="space-y-3">
        <textarea
          data-testid={`role-personalization-${segment}`}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          rows={14}
          placeholder={text.segments[segment].placeholder}
          className="w-full rounded border border-zinc-700 bg-zinc-950/70 p-2 text-xs text-zinc-200 focus:outline-none"
        />
        <button /* ds-allow:button: 正文保存的紧凑按钮，primitive 会改变布局 */
          data-testid={`role-personalization-save-${segment}`}
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="rounded bg-emerald-500/20 px-3 py-1.5 text-xs text-badge-success disabled:opacity-50"
        >
          {busy ? text.saving : text.save}
        </button>
        {error ? <div className="text-xs text-badge-danger">{error}</div> : null}
      </div>
    </SettingsSection>
  );
};

/**
 * 常驻边界：硬约束块。与三段正文分开——它由系统强制执行，正文只进提示词。
 * 独立保存，避免和某一段正文的保存耦合（那会让"没编辑正文就改不了边界"）。
 */
const BoundarySection: React.FC<{
  roleId: string;
  initialDisallowExternalSending: boolean;
  onSaved: () => void;
}> = ({ roleId, initialDisallowExternalSending, onSaved }) => {
  const { t } = useI18n();
  const text = t.expert.rolePersonalization;
  const [disallowExternalSending, setDisallowExternalSending] = useState(initialDisallowExternalSending);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await savePersonalization(roleId, { boundaries: { disallowExternalSending } });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection title={text.boundarySection.title} description={text.boundarySection.description}>
      <div className="space-y-3 rounded border border-zinc-700 bg-zinc-950/50 p-3">
        <label className="flex items-start gap-2 text-xs text-zinc-200">
          <input
            data-testid="role-personalization-boundary-external-sending"
            type="checkbox"
            checked={disallowExternalSending}
            onChange={(event) => setDisallowExternalSending(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="block font-medium">{text.hardBoundary.label}</span>
            <span className="mt-1 block leading-5 text-zinc-400">{text.hardBoundary.description}</span>
          </span>
        </label>
        <div className="border-t border-zinc-800 pt-3 text-xs">
          <div className="font-medium text-zinc-300">{text.softGuidance.label}</div>
          <div className="mt-1 leading-5 text-zinc-500">{text.softGuidance.description}</div>
        </div>
        <button /* ds-allow:button: 与正文保存按钮同一紧凑样式，primitive 会改变布局 */
          data-testid="role-personalization-save-boundary"
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="rounded bg-emerald-500/20 px-3 py-1.5 text-xs text-badge-success disabled:opacity-50"
        >
          {busy ? text.saving : text.save}
        </button>
        {error ? <div className="text-xs text-badge-danger">{error}</div> : null}
      </div>
    </SettingsSection>
  );
};

export const RolePersonalizationTab: React.FC<{
  roleId: string;
  personalization: RolePanelDetail['personalization'];
  identityEditor: React.ReactNode;
  onSaved: () => void;
}> = ({ roleId, personalization, identityEditor, onSaved }) => {
  const { t } = useI18n();
  const text = t.expert.rolePersonalization;
  const [segment, setSegment] = useState<Segment>('identity');
  return (
    <section data-testid="role-detail-personalization-tab" className="space-y-4">
      <BoundarySection
        roleId={roleId}
        initialDisallowExternalSending={personalization.boundaries?.disallowExternalSending ?? false}
        onSaved={onSaved}
      />
      <div className="flex flex-wrap gap-2" role="tablist">
        {SEGMENTS.map((key) => (
          <button /* ds-allow:button: 分段芯片为紧凑药丸样式，primitive 不兼容 */
            key={key}
            type="button"
            role="tab"
            aria-selected={segment === key}
            data-testid={`role-personalization-segment-${key}`}
            onClick={() => setSegment(key)}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${segment === key ? 'border-zinc-500 bg-zinc-700/60 text-zinc-100' : 'border-zinc-700/70 text-zinc-400 hover:text-zinc-200'}`}
          >
            {text.segments[key].title}
          </button>
        ))}
      </div>
      {segment === 'identity' ? identityEditor : null}
      {segment === 'expectation' ? (
        <ProseEditor key={`${roleId}:expectation`} segment="expectation" roleId={roleId} initial={personalization.userExpectation} onSaved={onSaved} />
      ) : null}
      {segment === 'soul' ? (
        <ProseEditor
          key={`${roleId}:soul`}
          segment="soul"
          roleId={roleId}
          initial={personalization.soul}
          onSaved={onSaved}
        />
      ) : null}
    </section>
  );
};
