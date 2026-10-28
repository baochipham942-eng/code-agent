// ============================================================================
// PermissionGrantList — 「你授权过的权限」统一列表（N-PERM-GRANT-LEDGER）
// ============================================================================
// 后端 IPC: domain:settings
//   actions: listPermissionGrants / revokePermissionGrant {id}
// 三个存档（按应用 / automation 长期授权 / 会话内放行）折成的归一台账（host 侧
// grantLedger.ts）。每行可撤销；撤销后下一次同类操作会重新询问。agent 侧没有任何
// 工具能列出或撤销这里的内容（no-self-revoke，见 tests/unit/permissions/grantLedger.test.ts）。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { PermissionGrantEntry } from '@shared/contract';
import ipcService from '../../../../services/ipcService';
import { SettingsSection } from '../SettingsLayout';
import { useI18n } from '../../../../hooks/useI18n';
import { zh } from '../../../../i18n/zh';
import { Button } from '../../../primitives';

type PermissionGrantsText = typeof zh.settings.privacy.permissionGrants;

function scopeLabel(source: string, copy: PermissionGrantsText['scope']): string {
  if (source === 'conversation') return copy.conversation;
  if (source === 'settings') return copy.always;
  return copy.automation.replace('{title}', source);
}

function kindLabel(kind: PermissionGrantEntry['kind'], copy: PermissionGrantsText['kind']): string {
  if (kind === 'app') return copy.app;
  if (kind === 'tool-target') return copy.toolTarget;
  return copy.toolSession;
}

const PermissionGrantList: React.FC = () => {
  const { t } = useI18n();
  const copy = t.settings.privacy.permissionGrants;
  const [grants, setGrants] = useState<PermissionGrantEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await ipcService.invokeDomain<PermissionGrantEntry[]>(
          IPC_DOMAINS.SETTINGS,
          'listPermissionGrants',
        );
        if (!cancelled && Array.isArray(rows)) setGrants(rows);
      } catch {
        // 列表拉不下来就当作没有授权；撤销动作仍会走真后端。
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleRevoke = useCallback(async (id: string) => {
    try {
      const result = await ipcService.invokeDomain<{ revoked: boolean }>(
        IPC_DOMAINS.SETTINGS,
        'revokePermissionGrant',
        { id },
      );
      if (result?.revoked) setGrants((rows) => rows.filter((row) => row.id !== id));
    } catch {
      // 撤销没落地就留着这一行。
    }
  }, []);

  return (
    <SettingsSection
      title={copy.title}
      description={copy.description}
    >
      {grants.length === 0 ? (
        <p className="text-xs text-zinc-500">{copy.empty}</p>
      ) : (
        <ul className="divide-y divide-zinc-800">
          {grants.map((grant) => (
            <li key={grant.id} data-testid="permission-grant-row" className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm text-zinc-200">{grant.label}</div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {kindLabel(grant.kind, copy.kind)}
                  {' · '}
                  {scopeLabel(grant.source, copy.scope)}
                  {' · '}
                  {copy.grantedOn.replace('{date}', new Date(grant.grantedAt).toLocaleDateString())}
                  {grant.expiresAt !== null ? ` · ${copy.expiresOn.replace('{date}', new Date(grant.expiresAt).toLocaleDateString())}` : ''}
                </div>
                {grant.kind === 'tool-target' && grant.detail ? (
                  <div className="mt-0.5 truncate text-xs text-zinc-400">{copy.targetLabel.replace('{target}', grant.detail)}</div>
                ) : null}
              </div>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                data-testid="permission-grant-revoke"
                onClick={() => { void handleRevoke(grant.id); }}
              >
                {copy.revoke}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
};

export default PermissionGrantList;
