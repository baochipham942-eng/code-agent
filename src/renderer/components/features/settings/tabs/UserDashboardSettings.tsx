// ============================================================================
// UserDashboardSettings - registered users dashboard
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, RefreshCw, Search, Shield, ShieldCheck, Users } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type {
  AdminUserDashboardItem,
  AdminUserDashboardResult,
} from '@shared/contract';
import { Button } from '../../../primitives';
import { SettingsPage, SettingsSection } from '../SettingsLayout';
import ipcService from '../../../../services/ipcService';
import { useAuthStore } from '../../../../stores/authStore';
import { useI18n } from '../../../../hooks/useI18n';
import { zh } from '../../../../i18n/zh';

type UserStatusFilter = 'all' | AdminUserDashboardItem['status'];
const DEFAULT_USER_DASHBOARD_TEXT = zh.settings.users;

const STATUS_CLASSES: Record<AdminUserDashboardItem['status'], string> = {
  active: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  suspended: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  deleted: 'border-red-500/30 bg-red-500/10 text-red-300',
};

const STATUS_FILTERS: UserStatusFilter[] = ['all', 'active', 'suspended', 'deleted'];

function formatDate(
  value?: string | number,
  emptyLabel = DEFAULT_USER_DASHBOARD_TEXT.dateNever,
): string {
  if (!value) return emptyLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return emptyLabel;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function getDisplayName(user: AdminUserDashboardItem): string {
  return user.nickname || user.username || user.email || user.id;
}

function matchesQuery(user: AdminUserDashboardItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    user.email,
    user.username,
    user.nickname,
    user.inviteCode,
    user.signupSource,
    user.provider,
    user.id,
  ].some((value) => value?.toLowerCase().includes(normalized));
}

const SummaryTile: React.FC<{
  label: string;
  value: number;
  tone?: 'default' | 'success' | 'warning';
}> = ({ label, value, tone = 'default' }) => {
  const valueClass = tone === 'success'
    ? 'text-emerald-300'
    : tone === 'warning'
      ? 'text-amber-300'
      : 'text-zinc-100';

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <div className={`text-xl font-semibold ${valueClass}`}>{value}</div>
      <div className="mt-1 text-xs text-zinc-500">{label}</div>
    </div>
  );
};

export const UserDashboardSettings: React.FC = () => {
  const { t } = useI18n();
  const userText = t.settings.users;
  const currentUserId = useAuthStore((state) => state.user?.id);
  const [users, setUsers] = useState<AdminUserDashboardItem[]>([]);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<UserStatusFilter>('all');
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await ipcService.invokeDomain<AdminUserDashboardResult>(
        IPC_DOMAINS.ADMIN,
        'listUsers',
      );
      setUsers(result.users);
      setUnavailableReason(result.unavailableReason || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  // 给某用户开/关「团队共享 key」。IPC 写 entitlement 后返回刷新后的用户列表。
  const toggleSharedRelay = useCallback(async (user: AdminUserDashboardItem) => {
    setBusyUserId(user.id);
    setError(null);
    try {
      const result = await ipcService.invokeDomain<AdminUserDashboardResult>(
        IPC_DOMAINS.ADMIN,
        'setSharedRelay',
        { userId: user.id, enabled: !user.hasSharedRelay },
      );
      setUsers(result.users);
      setUnavailableReason(result.unavailableReason || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyUserId(null);
    }
  }, []);

  const toggleUserAdmin = useCallback(async (user: AdminUserDashboardItem) => {
    setBusyUserId(user.id);
    setError(null);
    try {
      const result = await ipcService.invokeDomain<AdminUserDashboardResult>(
        IPC_DOMAINS.ADMIN,
        'setUserAdmin',
        { userId: user.id, enabled: !user.isAdmin },
      );
      setUsers(result.users);
      setUnavailableReason(result.unavailableReason || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyUserId(null);
    }
  }, []);

  const filteredUsers = useMemo(() => {
    return users.filter((user) => {
      const statusMatched = statusFilter === 'all' || user.status === statusFilter;
      return statusMatched && matchesQuery(user, query);
    });
  }, [query, statusFilter, users]);

  const summary = useMemo(() => {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return {
      total: users.length,
      active: users.filter((user) => user.status === 'active').length,
      admins: users.filter((user) => user.isAdmin).length,
      recent: users.filter((user) => {
        const lastSeen = user.lastActiveAt || user.lastSignInAt;
        return lastSeen ? new Date(lastSeen).getTime() >= sevenDaysAgo : false;
      }).length,
    };
  }, [users]);

  return (
    <SettingsPage
      title={userText.title}
      description={userText.description}
    >
      <SettingsSection
        title={userText.overviewTitle}
        actions={(
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={loadUsers}
            loading={loading}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            {userText.refresh}
          </Button>
        )}
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <SummaryTile label={userText.summary.registeredUsers} value={summary.total} />
          <SummaryTile label={userText.summary.activeStatus} value={summary.active} tone="success" />
          <SummaryTile label={userText.summary.admins} value={summary.admins} tone="warning" />
          <SummaryTile label={userText.summary.active7Days} value={summary.recent} />
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

      <SettingsSection title={userText.fields.title}>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-300">
              <Users className="h-3.5 w-3.5 text-emerald-300" />
              {userText.fields.connectedTitle}
            </div>
            <div className="text-xs leading-6 text-zinc-500">
              {userText.fields.connectedBody}
            </div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-300">
              <Shield className="h-3.5 w-3.5 text-amber-300" />
              {userText.fields.excludedTitle}
            </div>
            <div className="text-xs leading-6 text-zinc-500">
              {userText.fields.excludedBody}
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={userText.list.title}>
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="relative md:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={userText.list.searchPlaceholder}
              className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-hidden"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter}
                type="button"
                onClick={() => setStatusFilter(filter)}
                className={`h-8 rounded-md px-3 text-xs transition-colors ${
                  statusFilter === filter
                    ? 'bg-zinc-200 text-zinc-950'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                }`}
              >
                {filter === 'all' ? userText.statusFilters.all : userText.statusLabels[filter]}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-zinc-800">
          <div className="overflow-x-auto">
            <table className="min-w-[1100px] w-full text-left text-xs">
              <thead className="bg-zinc-900/80 text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">{userText.list.columns.user}</th>
                  <th className="px-3 py-2 font-medium">{userText.list.columns.role}</th>
                  <th className="px-3 py-2 font-medium">{userText.list.columns.status}</th>
                  <th className="px-3 py-2 font-medium">{userText.list.columns.sharedKey}</th>
                  <th className="px-3 py-2 font-medium">{userText.list.columns.source}</th>
                  <th className="px-3 py-2 font-medium">{userText.list.columns.createdAt}</th>
                  <th className="px-3 py-2 font-medium">{userText.list.columns.lastSignInAt}</th>
                  <th className="px-3 py-2 font-medium">{userText.list.columns.lastActiveAt}</th>
                  <th className="px-3 py-2 text-right font-medium">{userText.list.columns.devices}</th>
                  <th className="px-3 py-2 text-right font-medium">{userText.list.columns.sessionsMessages}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800 bg-zinc-950/40 text-zinc-300">
                {filteredUsers.map((user) => (
                  <tr key={user.id} className="hover:bg-zinc-900/60">
                    <td className="px-3 py-3">
                      <div className="font-medium text-zinc-100">{getDisplayName(user)}</div>
                      <div className="mt-1 truncate text-zinc-500" title={user.email}>{user.email}</div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        {user.isAdmin ? (
                          <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
                            Admin
                          </span>
                        ) : (
                          <span className="text-zinc-500">{userText.role.user}</span>
                        )}
                        <button
                          type="button"
                          disabled={busyUserId === user.id || (user.isAdmin && user.id === currentUserId)}
                          onClick={() => void toggleUserAdmin(user)}
                          title={
                            user.isAdmin
                              ? user.id === currentUserId
                                ? userText.role.selfAdminTitle
                                : userText.role.removeAdminTitle
                              : userText.role.setAdminTitle
                          }
                          className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                            user.isAdmin
                              ? 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                              : 'border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
                          }`}
                        >
                          <ShieldCheck className="h-3 w-3" />
                          {busyUserId === user.id
                            ? '…'
                            : user.isAdmin
                              ? user.id === currentUserId ? userText.role.self : userText.role.remove
                              : userText.role.setAdmin}
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <span className={`rounded-md border px-2 py-1 text-[11px] ${STATUS_CLASSES[user.status]}`}>
                        {userText.statusLabels[user.status]}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <button
                        type="button"
                        disabled={busyUserId === user.id}
                        onClick={() => void toggleSharedRelay(user)}
                        title={user.hasSharedRelay ? userText.sharedRelay.revokeTitle : userText.sharedRelay.grantTitle}
                        className={`rounded-md px-2 py-1 text-[11px] transition-colors disabled:opacity-50 ${
                          user.hasSharedRelay
                            ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                            : 'border border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                        }`}
                      >
                        {busyUserId === user.id ? '…' : user.hasSharedRelay ? userText.sharedRelay.enabled : userText.sharedRelay.open}
                      </button>
                    </td>
                    <td className="px-3 py-3">
                      <div className="text-zinc-300">{user.signupSource || user.provider || 'unknown'}</div>
                      <div className="mt-1 font-mono text-[11px] text-zinc-500">{user.inviteCode || '-'}</div>
                    </td>
                    <td className="px-3 py-3 text-zinc-400">{formatDate(user.createdAt, userText.dateNever)}</td>
                    <td className="px-3 py-3 text-zinc-400">{formatDate(user.lastSignInAt, userText.dateNever)}</td>
                    <td className="px-3 py-3 text-zinc-400">
                      {formatDate(user.lastActiveAt || user.lastSessionUpdatedAt, userText.dateNever)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-zinc-300">{user.deviceCount}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-zinc-300">
                      {user.sessionCount} / {user.messageCount}
                    </td>
                  </tr>
                ))}
                {!loading && filteredUsers.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-3 py-10 text-center text-zinc-500">
                      {userText.list.noMatches}
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
