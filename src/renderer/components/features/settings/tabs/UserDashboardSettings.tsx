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

type UserStatusFilter = 'all' | AdminUserDashboardItem['status'];

const STATUS_LABELS: Record<AdminUserDashboardItem['status'], string> = {
  active: '正常',
  suspended: '暂停',
  deleted: '删除',
};

const STATUS_CLASSES: Record<AdminUserDashboardItem['status'], string> = {
  active: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  suspended: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  deleted: 'border-red-500/30 bg-red-500/10 text-red-300',
};

const STATUS_FILTERS: Array<{ value: UserStatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '正常' },
  { value: 'suspended', label: '暂停' },
  { value: 'deleted', label: '删除' },
];

function formatDate(value?: string | number): string {
  if (!value) return '从未';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '从未';
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
      title="用户管理"
      description="注册用户、注册时间、登录与活跃信息放在同一张运营表里。"
    >
      <SettingsSection
        title="用户概览"
        actions={(
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={loadUsers}
            loading={loading}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            刷新
          </Button>
        )}
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <SummaryTile label="注册用户" value={summary.total} />
          <SummaryTile label="正常状态" value={summary.active} tone="success" />
          <SummaryTile label="管理员" value={summary.admins} tone="warning" />
          <SummaryTile label="7 天内活跃" value={summary.recent} />
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

      <SettingsSection title="字段口径">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-300">
              <Users className="h-3.5 w-3.5 text-emerald-300" />
              已接入
            </div>
            <div className="text-xs leading-6 text-zinc-500">
              邮箱、昵称、角色、状态、注册来源、邀请码、注册时间、上次登录、最近活跃、同步时间、设备数、会话数、消息数
            </div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-300">
              <Shield className="h-3.5 w-3.5 text-amber-300" />
              暂不放入看板
            </div>
            <div className="text-xs leading-6 text-zinc-500">
              原始 token、OAuth identity 明细、IP、设备指纹、计费额度。当前功能链路里没有稳定来源，展示会制造误判。
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="注册用户">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="relative md:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索邮箱、昵称、邀请码"
              className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-hidden"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                onClick={() => setStatusFilter(filter.value)}
                className={`h-8 rounded-md px-3 text-xs transition-colors ${
                  statusFilter === filter.value
                    ? 'bg-zinc-200 text-zinc-950'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-zinc-800">
          <div className="overflow-x-auto">
            <table className="min-w-[1100px] w-full text-left text-xs">
              <thead className="bg-zinc-900/80 text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">用户</th>
                  <th className="px-3 py-2 font-medium">角色</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">共享 key</th>
                  <th className="px-3 py-2 font-medium">来源</th>
                  <th className="px-3 py-2 font-medium">注册时间</th>
                  <th className="px-3 py-2 font-medium">上次登录</th>
                  <th className="px-3 py-2 font-medium">最近活跃</th>
                  <th className="px-3 py-2 text-right font-medium">设备</th>
                  <th className="px-3 py-2 text-right font-medium">会话 / 消息</th>
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
                          <span className="text-zinc-500">用户</span>
                        )}
                        <button
                          type="button"
                          disabled={busyUserId === user.id || (user.isAdmin && user.id === currentUserId)}
                          onClick={() => void toggleUserAdmin(user)}
                          title={
                            user.isAdmin
                              ? user.id === currentUserId
                                ? '不能撤销自己的管理员角色'
                                : '点击撤销管理员角色'
                              : '点击设为管理员'
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
                              ? user.id === currentUserId ? '本人' : '撤销'
                              : '设为 Admin'}
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <span className={`rounded-md border px-2 py-1 text-[11px] ${STATUS_CLASSES[user.status]}`}>
                        {STATUS_LABELS[user.status]}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <button
                        type="button"
                        disabled={busyUserId === user.id}
                        onClick={() => void toggleSharedRelay(user)}
                        title={user.hasSharedRelay ? '点击撤销团队共享 key' : '点击授予团队共享 key'}
                        className={`rounded-md px-2 py-1 text-[11px] transition-colors disabled:opacity-50 ${
                          user.hasSharedRelay
                            ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                            : 'border border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                        }`}
                      >
                        {busyUserId === user.id ? '…' : user.hasSharedRelay ? '● 已开' : '○ 开通'}
                      </button>
                    </td>
                    <td className="px-3 py-3">
                      <div className="text-zinc-300">{user.signupSource || user.provider || 'unknown'}</div>
                      <div className="mt-1 font-mono text-[11px] text-zinc-500">{user.inviteCode || '-'}</div>
                    </td>
                    <td className="px-3 py-3 text-zinc-400">{formatDate(user.createdAt)}</td>
                    <td className="px-3 py-3 text-zinc-400">{formatDate(user.lastSignInAt)}</td>
                    <td className="px-3 py-3 text-zinc-400">
                      {formatDate(user.lastActiveAt || user.lastSessionUpdatedAt)}
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
                      没有匹配的用户
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
