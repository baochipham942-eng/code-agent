import React, { useEffect, useMemo, useState } from 'react';
import { Users } from 'lucide-react';
import type { AdminUserDashboardItem, AdminUserDashboardResult } from '@shared/contract';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../services/ipcService';
import { Select } from '../../primitives/Select';

export interface AdminUserScopeValue {
  userId?: string | null;
  unassignedOnly?: boolean;
}

interface AdminUserScopeSelectProps {
  value: AdminUserScopeValue;
  onChange: (value: AdminUserScopeValue) => void;
  className?: string;
}

function getDisplayName(user: AdminUserDashboardItem): string {
  return user.nickname || user.username || user.email || user.id;
}

export const AdminUserScopeSelect: React.FC<AdminUserScopeSelectProps> = ({ value, onChange, className = '' }) => {
  const [users, setUsers] = useState<AdminUserDashboardItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    ipcService
      .invokeDomain<AdminUserDashboardResult>(IPC_DOMAINS.ADMIN, 'listUsers')
      .then((result) => {
        if (!cancelled) setUsers(result.users || []);
      })
      .catch(() => {
        if (!cancelled) setUsers([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectValue = value.unassignedOnly ? '__unassigned__' : value.userId || '__all__';

  const options = useMemo(
    () => [
      { value: '__all__', label: '全部用户' },
      { value: '__unassigned__', label: '未归属' },
      ...users.map((user) => ({
        value: user.id,
        label: getDisplayName(user)
      }))
    ],
    [users]
  );

  return (
    <div className={`flex min-w-[220px] items-center gap-2 ${className}`}>
      <Users className="h-3.5 w-3.5 text-zinc-500" />
      <Select
        aria-label="用户范围"
        value={selectValue}
        options={options}
        disabled={loading}
        selectSize="sm"
        fullWidth
        className="h-8 border-zinc-800 bg-zinc-950/70 px-3 text-xs"
        onChange={(event) => {
          const next = event.target.value;
          if (next === '__all__') {
            onChange({});
          } else if (next === '__unassigned__') {
            onChange({ unassignedOnly: true });
          } else {
            onChange({ userId: next });
          }
        }}
      />
    </div>
  );
};
