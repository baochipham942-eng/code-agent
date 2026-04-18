import { describe, expect, it } from 'vitest';
import type { ConnectorStatusSummary } from '../../../src/shared/ipc';
import {
  normalizeConnectorStatuses,
  serializeConnectorStatuses,
} from '../../../src/main/ipc/connector.ipc';

describe('connector.ipc helpers', () => {
  it('normalizes connector statuses into a stable order', () => {
    const input: ConnectorStatusSummary[] = [
      {
        id: 'reminders',
        label: 'Reminders',
        connected: false,
        detail: 'denied',
        capabilities: ['update_reminder', 'list_lists'],
      },
      {
        id: 'calendar',
        label: 'Calendar',
        connected: true,
        detail: 'ok',
        capabilities: ['list_events', 'get_status'],
      },
    ];

    expect(normalizeConnectorStatuses(input)).toEqual([
      {
        id: 'calendar',
        label: 'Calendar',
        connected: true,
        detail: 'ok',
        capabilities: ['get_status', 'list_events'],
      },
      {
        id: 'reminders',
        label: 'Reminders',
        connected: false,
        detail: 'denied',
        capabilities: ['list_lists', 'update_reminder'],
      },
    ]);
  });

  it('serializes logically equivalent snapshots to the same value', () => {
    const left: ConnectorStatusSummary[] = [
      {
        id: 'mail',
        label: 'Mail',
        connected: true,
        detail: 'ok',
        capabilities: ['send_message', 'get_status'],
      },
    ];
    const right: ConnectorStatusSummary[] = [
      {
        id: 'mail',
        label: 'Mail',
        connected: true,
        detail: 'ok',
        capabilities: ['get_status', 'send_message'],
      },
    ];

    expect(serializeConnectorStatuses(left)).toBe(serializeConnectorStatuses(right));
  });
});
