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
import { useI18n } from '../../../../hooks/useI18n';
import { localeForLanguage } from '../../../../utils/i18nTime';
import { zh } from '../../../../i18n/zh';

const DEFAULT_INVITE_CODES_TEXT = zh.settings.invites;

interface InviteCodeDraft {
  label: string;
  maxUses: string;
  expiresAt: string;
}

function formatDate(
  value?: string,
  emptyLabel = DEFAULT_INVITE_CODES_TEXT.noLimit,
  locale: string = localeForLanguage('zh'),
): string {
  if (!value) return emptyLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return emptyLabel;
  return date.toLocaleString(locale, {
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

function getInviteStatus(
  invite: AdminInviteCodeItem,
  labels = DEFAULT_INVITE_CODES_TEXT.statusLabels,
): {
  label: string;
  className: string;
} {
  if (!invite.isActive) {
    return { label: labels.inactive, className: 'border-zinc-700 bg-zinc-800 text-zinc-400' };
  }
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
    return { label: labels.expired, className: 'border-red-500/30 bg-red-500/10 text-red-300' };
  }
  if (invite.remainingUses <= 0) {
    return { label: labels.exhausted, className: 'border-amber-500/30 bg-amber-500/10 text-amber-300' };
  }
  return { label: labels.usable, className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' };
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
  const { t, language } = useI18n();
  const inviteText = t.settings.invites;
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
    usable: inviteCodes.filter((invite) => getInviteStatus(invite, inviteText.statusLabels).label === inviteText.statusLabels.usable).length,
    used: inviteCodes.reduce((sum, invite) => sum + invite.useCount, 0),
    remaining: inviteCodes.reduce((sum, invite) => sum + invite.remainingUses, 0),
  }), [inviteCodes, inviteText]);

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
      title={inviteText.title}
      description={inviteText.description}
    >
      <SettingsSection
        title={inviteText.overviewTitle}
        actions={(
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={loadInviteCodes}
            loading={loading}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            {inviteText.refresh}
          </Button>
        )}
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
            <div className="text-xl font-semibold text-zinc-100">{summary.total}</div>
            <div className="mt-1 text-xs text-zinc-500">{inviteText.summary.invites}</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
            <div className="text-xl font-semibold text-emerald-300">{summary.usable}</div>
            <div className="mt-1 text-xs text-zinc-500">{inviteText.statusLabels.usable}</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
            <div className="text-xl font-semibold text-zinc-100">{summary.used}</div>
            <div className="mt-1 text-xs text-zinc-500">{inviteText.summary.used}</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
            <div className="text-xl font-semibold text-zinc-100">{summary.remaining}</div>
            <div className="mt-1 text-xs text-zinc-500">{inviteText.summary.remainingUses}</div>
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

      <SettingsSection title={inviteText.create.title}>
        <div className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 md:grid-cols-[1fr_1fr_120px_210px_auto]">
          <input
            type="text"
            value={newCode}
            onChange={(event) => setNewCode(normalizeCodeInput(event.target.value))}
            placeholder={inviteText.create.codePlaceholder}
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-hidden"
          />
          <input
            type="text"
            value={newLabel}
            onChange={(event) => setNewLabel(event.target.value)}
            placeholder={inviteText.create.labelPlaceholder}
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-hidden"
          />
          <input
            type="number"
            min={1}
            value={newMaxUses}
            onChange={(event) => setNewMaxUses(event.target.value)}
            aria-label={inviteText.create.maxUsesAria}
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 focus:border-zinc-600 focus:outline-hidden"
          />
          <input
            type="datetime-local"
            value={newExpiresAt}
            onChange={(event) => setNewExpiresAt(event.target.value)}
            aria-label={inviteText.create.expiresAtAria}
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 focus:border-zinc-600 focus:outline-hidden"
          />
          <Button
            type="button"
            size="sm"
            onClick={createInviteCode}
            loading={loading}
            leftIcon={<Ticket className="h-3.5 w-3.5" />}
          >
            {inviteText.create.create}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection title={inviteText.fields.title}>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs leading-6 text-zinc-500">
          {inviteText.fields.line1}
          {' '}
          {inviteText.fields.line2}
        </div>
      </SettingsSection>

      <SettingsSection title={inviteText.list.title}>
        <div className="relative md:w-80">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={inviteText.list.searchPlaceholder}
            className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-hidden"
          />
        </div>

        <div className="overflow-hidden rounded-lg border border-zinc-800">
          <div className="overflow-x-auto">
            <table className="min-w-[1180px] w-full text-left text-xs">
              <thead className="bg-zinc-900/80 text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">{inviteText.list.columns.inviteCode}</th>
                  <th className="px-3 py-2 font-medium">{inviteText.list.columns.remark}</th>
                  <th className="px-3 py-2 font-medium">{inviteText.list.columns.status}</th>
                  <th className="px-3 py-2 font-medium">{inviteText.list.columns.uses}</th>
                  <th className="px-3 py-2 font-medium">{inviteText.list.columns.expiresAt}</th>
                  <th className="px-3 py-2 font-medium">{inviteText.list.columns.createdInfo}</th>
                  <th className="px-3 py-2 font-medium">{inviteText.list.columns.lastUsedAt}</th>
                  <th className="px-3 py-2 text-right font-medium">{inviteText.list.columns.action}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800 bg-zinc-950/40 text-zinc-300">
                {filteredInviteCodes.map((invite) => {
                  const draft = drafts[invite.id] || {
                    label: invite.label || '',
                    maxUses: String(invite.maxUses),
                    expiresAt: toDateTimeInput(invite.expiresAt),
                  };
                  const status = getInviteStatus(invite, inviteText.statusLabels);
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
                          className="h-8 w-44 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-hidden"
                          placeholder={inviteText.list.remarkPlaceholder}
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
                            className="h-8 w-20 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200 focus:border-zinc-600 focus:outline-hidden"
                          />
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <input
                          type="datetime-local"
                          value={draft.expiresAt}
                          onChange={(event) => updateDraft(invite.id, { expiresAt: event.target.value })}
                          className="h-8 w-44 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200 focus:border-zinc-600 focus:outline-hidden"
                        />
                        <div className="mt-1 text-[11px] text-zinc-500">{formatDate(invite.expiresAt, inviteText.noLimit, localeForLanguage(language))}</div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="text-zinc-400">{formatDate(invite.createdAt, inviteText.noLimit, localeForLanguage(language))}</div>
                        <div className="mt-1 truncate text-[11px] text-zinc-500" title={invite.createdByEmail}>
                          {invite.createdByEmail || '-'}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-zinc-400">{formatDate(invite.lastUsedAt, inviteText.noLimit, localeForLanguage(language))}</td>
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
                            {inviteText.list.copy}
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => saveInviteCode(invite)}
                            loading={savingId === invite.id}
                          >
                            {t.common.save}
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
                            {invite.isActive ? inviteText.list.disable : inviteText.list.enable}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!loading && filteredInviteCodes.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 py-10 text-center text-zinc-500">
                      {inviteText.list.noMatches}
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
