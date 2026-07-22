import React from 'react';
import { AlertTriangle, Download, RefreshCw, Trash2 } from 'lucide-react';
import type { RolePackListItem } from '../../../services/rolesClient';
import { useI18n } from '../../../hooks/useI18n';
import { Badge } from '../../primitives/Badge';
import { Button } from '../../primitives/Button';
import { EmptyState } from '../../primitives/EmptyState';

export interface RolePackHealthNoticeProps {
  item: RolePackListItem;
  onRetryMissingSkills: (roleId: string) => void;
  busy?: boolean;
}

/** ADR-048 §5: E6 will surface the same warning on in-session role cards. */
export const RolePackHealthNotice: React.FC<RolePackHealthNoticeProps> = ({ item, onRetryMissingSkills, busy = false }) => {
  const { t } = useI18n();
  const text = t.rolePack;
  const missingSkills = item.missingSkills ?? [];

  return (
    <div className="space-y-1.5">
      {item.installState === 'degraded' ? (
        <div data-testid={`role-pack-degraded-${item.entry.roleId}`} className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2">
          <div className="flex items-center gap-1.5 text-xs text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>{text.degraded.replace('{count}', String(missingSkills.length))}</span>
          </div>
          <p data-testid={`role-pack-missing-skills-${item.entry.roleId}`} className="mt-1 text-[11px] leading-relaxed text-amber-100/80">
            {text.missingSkills.replace('{skills}', missingSkills.join('、'))}
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            loading={busy}
            disabled={busy}
            data-testid={`role-pack-retry-missing-${item.entry.roleId}`}
            onClick={() => onRetryMissingSkills(item.entry.roleId)}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            {text.retryMissingSkills}
          </Button>
        </div>
      ) : null}
      {item.locallyModified ? (
        <p data-testid={`role-pack-locally-modified-${item.entry.roleId}`} className="text-[11px] leading-relaxed text-amber-200/80">
          {text.locallyModified}
        </p>
      ) : null}
    </div>
  );
};

interface RolePackShelfProps {
  items: RolePackListItem[];
  loading: boolean;
  error: boolean;
  busyRoleId: string | null;
  onRetryLoad: () => void;
  onInstall: (roleId: string) => void;
  onUninstall: (roleId: string) => void;
  onRetryMissingSkills: (roleId: string) => void;
}

export const RolePackShelf: React.FC<RolePackShelfProps> = ({
  items,
  loading,
  error,
  busyRoleId,
  onRetryLoad,
  onInstall,
  onUninstall,
  onRetryMissingSkills,
}) => {
  const { t } = useI18n();
  const text = t.rolePack;

  return (
    <section aria-labelledby="role-pack-shelf-title">
      <h2 id="role-pack-shelf-title" className="mb-3 text-sm font-medium text-zinc-200">{text.sectionTitle}</h2>
      {loading ? <p className="text-xs text-zinc-500">{text.loading}</p> : null}
      {!loading && error ? (
        <div data-testid="role-pack-load-error" className="space-y-2">
          <EmptyState variant="box" text={text.loadFailed} />
          <Button variant="secondary" size="sm" onClick={onRetryLoad}>{text.retryLoad}</Button>
        </div>
      ) : null}
      {!loading && !error && items.length === 0 ? <EmptyState variant="box" text={text.empty} /> : null}
      {!loading && !error && items.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => {
            const { entry } = item;
            const busy = busyRoleId === entry.roleId;
            return (
              <article key={entry.roleId} data-testid={`role-pack-card-${entry.roleId}`} className="flex flex-col gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5">
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-medium text-zinc-100">{entry.displayName || entry.roleId}</h3>
                      <p className="mt-0.5 text-xs text-zinc-500">{entry.visual.profession}</p>
                    </div>
                    {item.installed ? <Badge className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-200">{text.installed}</Badge> : null}
                  </div>
                  {entry.description ? <p className="mt-2 text-xs leading-relaxed text-zinc-400">{entry.description}</p> : null}
                </div>
                {entry.tags && entry.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {entry.tags.map((tag) => <Badge key={tag} className="border-zinc-700 bg-zinc-800 text-[10px] text-zinc-400">{tag}</Badge>)}
                  </div>
                ) : null}
                <div className="space-y-1 text-[11px] text-zinc-500">
                  <p><span className="text-zinc-400">{text.skills}</span>{': '}{entry.skills.map((skill) => skill.registryName).join('、')}</p>
                  <p><span className="text-zinc-400">{text.tools}</span>{': '}{item.tools.join('、')}</p>
                  <p><span className="text-zinc-400">{text.publisher}</span>{': '}{entry.publisher}</p>
                  <p><span className="text-zinc-400">{text.version}</span>{': '}{entry.packVersion}</p>
                </div>
                <RolePackHealthNotice item={item} busy={busy} onRetryMissingSkills={onRetryMissingSkills} />
                <div className="mt-auto flex gap-2 pt-1">
                  {!item.installed ? (
                    <Button variant="primary" size="sm" loading={busy} disabled={busy} data-testid={`role-pack-install-${entry.roleId}`} onClick={() => onInstall(entry.roleId)} leftIcon={<Download className="h-3.5 w-3.5" />}>
                      {text.install}
                    </Button>
                  ) : (
                    <>
                      {item.hasUpdate ? (
                        <Button variant="primary" size="sm" loading={busy} disabled={busy} data-testid={`role-pack-upgrade-${entry.roleId}`} onClick={() => onInstall(entry.roleId)}>
                          {text.upgrade}
                        </Button>
                      ) : null}
                      <Button variant="ghost" size="sm" loading={busy} disabled={busy} data-testid={`role-pack-uninstall-${entry.roleId}`} onClick={() => onUninstall(entry.roleId)} leftIcon={<Trash2 className="h-3.5 w-3.5" />}>
                        {text.uninstall}
                      </Button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
};
