// ============================================================================
// InviteCodesSettings - invite code management
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  Clipboard,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Ticket,
} from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type {
  AdminInviteCodeItem,
  AdminInviteCodeListResult,
} from '@shared/contract';
import { Button } from '../../../primitives';
import { SettingsPage, SettingsSection } from '../SettingsLayout';
import ipcService from '../../../../services/ipcService';

interface InviteCodeDraft {
  label: string;
  maxUses: string;
  expiresAt: string;
}

function formatDate(value?: string): string {
  if (!value) return '不限';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '不限';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function toDateTimeInput(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 16);
}

function toIsoOrNull(value: string): string | null {
  if (!value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getInviteStatus(invite: AdminInviteCodeItem): {
  label: string;
  className: string;
} {
  if (!invite.isActive) {
    return { label: '停用', className: 'border-zinc-700 bg-zinc-800 text-zinc-400' };
  }
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
    return { label: '过期', className: 'border-red-500/30 bg-red-500/10 text-red-300' };
  }
  if (invite.remainingUses <= 0) {
    return { label: '用完', className: 'border-amber-500/30 bg-amber-500/10 text-amber-300' };
  }
  return { label: '可用', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' };
}

function normalizeCodeInput(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

function matchesQuery(invite: AdminInviteCodeItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    invite.code,
    invite.label,
    invite.createdByEmail,
  ].some((value) => value?.toLowerCase().includes(normalized));
}

export const InviteCodesSettings: React.FC = () => {
  const [inviteCodes, setInviteCodes] = useState<AdminInviteCodeItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, InviteCodeDraft>>({});
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [newCode, setNewCode] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newMaxUses, setNewMaxUses] = useState('1');
  const [newExpiresAt, setNewExpiresAt] = useState('');

  const applyInviteResult = useCallback((result: AdminInviteCodeListResult) => {
    setInviteCodes(result.inviteCodes);
    setUnavailableReason(result.unavailableReason || null);
    setDrafts(Object.fromEntries(result.inviteCodes.map((invite) => [
      invite.id,
      {
        label: invite.label || '',
        maxUses: String(invite.maxUses),
        expiresAt: toDateTimeInput(invite.expiresAt),
      },
    ])));
  }, []);

  const loadInviteCodes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await ipcService.invokeDomain<AdminInviteCodeListResult>(
        IPC_DOMAINS.ADMIN,
        'listInviteCodes',
      );
      applyInviteResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [applyInviteResult]);

  useEffect(() => {
    void loadInviteCodes();
  }, [loadInviteCodes]);

  const filteredInviteCodes = useMemo(
    () => inviteCodes.filter((invite) => matchesQuery(invite, query)),
    [inviteCodes, query],
  );

  const summary = useMemo(() => ({
    total: inviteCodes.length,
    usable: inviteCodes.filter((invite) => getInviteStatus(invite).label === '可用').length,
    used: inviteCodes.reduce((sum, invite) => sum + invite.useCount, 0),
    remaining: inviteCodes.reduce((sum, invite) => sum + invite.remainingUses, 0),
  }), [inviteCodes]);

  const createInviteCode = useCallback(async () => {
    const maxUses = Math.max(Number.parseInt(newMaxUses, 10) || 1, 1);
    setLoading(true);
    setError(null);
    try {
      const result = await ipcService.invokeDomain<AdminInviteCodeListResult>(
        IPC_DOMAINS.ADMIN,
        'createInviteCode',
        {
          code: newCode.trim() || undefined,
          label: newLabel.trim() || undefined,
          maxUses,
          expiresAt: toIsoOrNull(newExpiresAt),
        },
      );
      applyInviteResult(result);
      setNewCode('');
      setNewLabel('');
      setNewMaxUses('1');
      setNewExpiresAt('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [applyInviteResult, newCode, newExpiresAt, newLabel, newMaxUses]);

  const updateDraft = useCallback((id: string, patch: Partial<InviteCodeDraft>) => {
    setDrafts((prev) => ({
      ...prev,
      [id]: {
        ...(prev[id] || { label: '', maxUses: '1', expiresAt: '' }),
        ...patch,
      },
    }));
  }, []);

  const saveInviteCode = useCallback(async (invite: AdminInviteCodeItem, isActive = invite.isActive) => {
    const draft = drafts[invite.id];
    if (!draft) return;
    const maxUses = Math.max(Number.parseInt(draft.maxUses, 10) || invite.maxUses, 1);
    setSavingId(invite.id);
    setError(null);
    try {
      const result = await ipcService.invokeDomain<AdminInviteCodeListResult>(
        IPC_DOMAINS.ADMIN,
        'updateInviteCode',
        {
          id: invite.id,
          label: draft.label.trim(),
          maxUses,
          expiresAt: toIsoOrNull(draft.expiresAt),
          isActive,
        },
      );
      applyInviteResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId(null);
    }
  }, [applyInviteResult, drafts]);

  const copyInviteCode = useCallback(async (code: string) => {
    await navigator.clipboard?.writeText(code);
    setCopiedCode(code);
    window.setTimeout(() => setCopiedCode(null), 1200);
  }, []);

  return (
    <SettingsPage
      title="邀请码管理"
      description="邀请码决定注册入口，使用次数、有效期和停用状态在这里维护。"
    >
      <SettingsSection
        title="邀请码概览"
        actions={(
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={loadInviteCodes}
            loading={loading}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            刷新
          </Button>
        )}
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
            <div className="text-xl font-semibold text-zinc-100">{summary.total}</div>
            <div className="mt-1 text-xs text-zinc-500">邀请码</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
            <div className="text-xl font-semibold text-emerald-300">{summary.usable}</div>
            <div className="mt-1 text-xs text-zinc-500">可用</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
            <div className="text-xl font-semibold text-zinc-100">{summary.used}</div>
            <div className="mt-1 text-xs text-zinc-500">已使用</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
            <div className="text-xl font-semibold text-zinc-100">{summary.remaining}</div>
            <div className="mt-1 text-xs text-zinc-500">剩余次数</div>
          </div>
        </div>

        {unavailableReason && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{unavailableReason}</span>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="新建邀请码">
        <div className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 md:grid-cols-[1fr_1fr_120px_210px_auto]">
          <input
            type="text"
            value={newCode}
            onChange={(event) => setNewCode(normalizeCodeInput(event.target.value))}
            placeholder="自动生成或手填"
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
          />
          <input
            type="text"
            value={newLabel}
            onChange={(event) => setNewLabel(event.target.value)}
            placeholder="备注"
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
          />
          <input
            type="number"
            min={1}
            value={newMaxUses}
            onChange={(event) => setNewMaxUses(event.target.value)}
            aria-label="最大使用次数"
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 focus:border-zinc-600 focus:outline-none"
          />
          <input
            type="datetime-local"
            value={newExpiresAt}
            onChange={(event) => setNewExpiresAt(event.target.value)}
            aria-label="过期时间"
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 focus:border-zinc-600 focus:outline-none"
          />
          <Button
            type="button"
            size="sm"
            onClick={createInviteCode}
            loading={loading}
            leftIcon={<Ticket className="h-3.5 w-3.5" />}
          >
            创建
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection title="字段口径">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs leading-6 text-zinc-500">
          已有字段保留 code、max_uses、use_count、expires_at、is_active、created_at；新增 label、created_by、updated_at、last_used_at。
          不展示使用人明细、兑换 IP、设备指纹和批量导入模板，它们现在没有稳定业务动作支撑。
        </div>
      </SettingsSection>

      <SettingsSection title="邀请码列表">
        <div className="relative md:w-80">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索邀请码、备注、创建人"
            className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
          />
        </div>

        <div className="overflow-hidden rounded-lg border border-zinc-800">
          <div className="overflow-x-auto">
            <table className="min-w-[1180px] w-full text-left text-xs">
              <thead className="bg-zinc-900/80 text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">邀请码</th>
                  <th className="px-3 py-2 font-medium">备注</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">次数</th>
                  <th className="px-3 py-2 font-medium">过期时间</th>
                  <th className="px-3 py-2 font-medium">创建信息</th>
                  <th className="px-3 py-2 font-medium">最后使用</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800 bg-zinc-950/40 text-zinc-300">
                {filteredInviteCodes.map((invite) => {
                  const draft = drafts[invite.id] || {
                    label: invite.label || '',
                    maxUses: String(invite.maxUses),
                    expiresAt: toDateTimeInput(invite.expiresAt),
                  };
                  const status = getInviteStatus(invite);
                  return (
                    <tr key={invite.id} className="hover:bg-zinc-900/60">
                      <td className="px-3 py-3">
                        <div className="font-mono text-sm text-zinc-100">{invite.code}</div>
                        <div className="mt-1 text-[11px] text-zinc-500">{invite.id.slice(0, 8)}</div>
                      </td>
                      <td className="px-3 py-3">
                        <input
                          type="text"
                          value={draft.label}
                          onChange={(event) => updateDraft(invite.id, { label: event.target.value })}
                          className="h-8 w-44 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
                          placeholder="备注"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <span className={`rounded-md border px-2 py-1 text-[11px] ${status.className}`}>
                          {status.label}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <span className="tabular-nums text-zinc-400">{invite.useCount} /</span>
                          <input
                            type="number"
                            min={Math.max(invite.useCount, 1)}
                            value={draft.maxUses}
                            onChange={(event) => updateDraft(invite.id, { maxUses: event.target.value })}
                            className="h-8 w-20 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200 focus:border-zinc-600 focus:outline-none"
                          />
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <input
                          type="datetime-local"
                          value={draft.expiresAt}
                          onChange={(event) => updateDraft(invite.id, { expiresAt: event.target.value })}
                          className="h-8 w-44 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200 focus:border-zinc-600 focus:outline-none"
                        />
                        <div className="mt-1 text-[11px] text-zinc-500">{formatDate(invite.expiresAt)}</div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="text-zinc-400">{formatDate(invite.createdAt)}</div>
                        <div className="mt-1 truncate text-[11px] text-zinc-500" title={invite.createdByEmail}>
                          {invite.createdByEmail || '-'}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-zinc-400">{formatDate(invite.lastUsedAt)}</td>
                      <td className="px-3 py-3">
                        <div className="flex justify-end gap-1.5">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => copyInviteCode(invite.code)}
                            leftIcon={copiedCode === invite.code
                              ? <Check className="h-3.5 w-3.5" />
                              : <Clipboard className="h-3.5 w-3.5" />}
                          >
                            复制
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => saveInviteCode(invite)}
                            loading={savingId === invite.id}
                          >
                            保存
                          </Button>
                          <Button
                            type="button"
                            variant={invite.isActive ? 'danger' : 'secondary'}
                            size="sm"
                            onClick={() => saveInviteCode(invite, !invite.isActive)}
                            disabled={savingId === invite.id}
                            leftIcon={invite.isActive
                              ? <PowerOff className="h-3.5 w-3.5" />
                              : <Power className="h-3.5 w-3.5" />}
                          >
                            {invite.isActive ? '停用' : '启用'}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!loading && filteredInviteCodes.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 py-10 text-center text-zinc-500">
                      没有匹配的邀请码
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </SettingsSection>
    </SettingsPage>
  );
};
