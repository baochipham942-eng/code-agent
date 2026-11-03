import React from 'react';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { interpolate } from '../../../i18n/interpolate';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useConnectorStatuses } from '../../../hooks/useConnectorStatuses';
import { useConnectorRequiredStore, type ConnectorRequiredEntry } from '../../../stores/connectorRequiredStore';
import { connectorDisplayName } from '../../../utils/connectorDisplayName';
import { resumeConnectorTask } from '../../../utils/connectorRequiredWatcher';

function ConnectorRequiredCard({ entry, name }: { entry: ConnectorRequiredEntry; name: string }): React.ReactElement {
  const { t } = useI18n();
  const resuming = entry.status === 'resuming';
  return (
    <div data-testid={`connector-required-card-${entry.connectorId}`} className="mx-4 mb-2 flex items-center justify-between gap-3 rounded-lg border border-border-muted bg-surface-subtle px-3 py-2 text-sm text-zinc-300">
      <span className="min-w-0">
        <span className="block">{interpolate(resuming ? t.connectorRequired.resuming : t.connectorRequired.title, { name })}</span>
        {!resuming && <span className="block text-xs text-zinc-500">{t.connectorRequired.body}</span>}
      </span>
      {!resuming && (
        <span className="flex shrink-0 gap-2">
          {entry.gaveUp && (
            <Button type="button" variant="secondary" size="sm" data-testid="connector-required-manual" onClick={() => { resumeConnectorTask(entry); }}>{t.connectorRequired.manual}</Button>
          )}
          <Button type="button" variant="ghost" size="sm" data-testid="connector-required-later" onClick={() => useConnectorRequiredStore.getState().dismiss(entry.sessionId, entry.connectorId)}>{t.connectorRequired.later}</Button>
          <Button type="button" variant="secondary" size="sm" data-testid="connector-required-connect" onClick={() => useAppStore.getState().openCapabilitySettingsTarget({ kind: 'connector', id: entry.connectorId })}>{t.connectorRequired.connect}</Button>
        </span>
      )}
    </div>
  );
}

/** 当前会话里所有未处理的连接卡（每个未就绪连接器一张）。 */
export function ConnectorRequiredCards(): React.ReactElement | null {
  const sessionId = useSessionStore((state) => state.currentSessionId);
  const entries = useConnectorRequiredStore((state) => state.entries);
  const statuses = useConnectorStatuses();
  const visible = Object.values(entries).filter((entry) => entry.sessionId === sessionId && entry.status !== 'dismissed');
  if (visible.length === 0) return null;
  return (
    <>
      {visible.map((entry) => (
        <ConnectorRequiredCard key={entry.connectorId} entry={entry} name={connectorDisplayName(entry.connectorId, statuses)} />
      ))}
    </>
  );
}
