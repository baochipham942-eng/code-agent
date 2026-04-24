import { describe, expect, it } from 'vitest';
import type { ConnectorStatusSummary } from '../../../src/shared/ipc';
import {
  getEnabledNativeConnectorIdsAfterDisconnect,
  getEnabledNativeConnectorIdsAfterPermissionRepair,
  getEnabledNativeConnectorIdsAfterRetry,
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
        actions: ['remove', 'disconnect'],
        capabilities: ['update_reminder', 'list_lists'],
      },
      {
        id: 'calendar',
        label: 'Calendar',
        connected: true,
        detail: 'ok',
        actions: ['remove', 'disconnect'],
        capabilities: ['list_events', 'get_status'],
      },
    ];

    expect(normalizeConnectorStatuses(input)).toEqual([
      {
        id: 'calendar',
        label: 'Calendar',
        connected: true,
        detail: 'ok',
        actions: ['disconnect', 'remove'],
        capabilities: ['get_status', 'list_events'],
      },
      {
        id: 'reminders',
        label: 'Reminders',
        connected: false,
        detail: 'denied',
        actions: ['disconnect', 'remove'],
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

  it('turns retry into an enable path for known native connectors', () => {
    expect(getEnabledNativeConnectorIdsAfterRetry({
      connectorId: 'calendar',
      enabledNative: [],
      registered: false,
    })).toEqual(['calendar']);

    expect(getEnabledNativeConnectorIdsAfterRetry({
      connectorId: 'mail',
      enabledNative: ['calendar'],
      registered: false,
    })).toEqual(['calendar', 'mail']);

    expect(getEnabledNativeConnectorIdsAfterRetry({
      connectorId: 'mail',
      enabledNative: ['mail'],
      registered: false,
    })).toEqual(['mail']);
  });

  it('keeps retry as a status refresh for registered or unknown connectors', () => {
    expect(getEnabledNativeConnectorIdsAfterRetry({
      connectorId: 'calendar',
      enabledNative: ['calendar'],
      registered: true,
    })).toBeNull();

    expect(getEnabledNativeConnectorIdsAfterRetry({
      connectorId: 'slack',
      enabledNative: [],
      registered: false,
    })).toBeNull();

    expect(getEnabledNativeConnectorIdsAfterRetry({
      enabledNative: [],
      registered: false,
    })).toBeNull();
  });

  it('removes native connectors from enabled settings for disconnect/remove', () => {
    expect(getEnabledNativeConnectorIdsAfterDisconnect({
      connectorId: 'mail',
      enabledNative: ['calendar', 'mail', 'reminders'],
    })).toEqual(['calendar', 'reminders']);

    expect(getEnabledNativeConnectorIdsAfterDisconnect({
      connectorId: 'slack',
      enabledNative: ['calendar'],
    })).toBeNull();
  });

  it('enables native connectors before running permission repair', () => {
    expect(getEnabledNativeConnectorIdsAfterPermissionRepair({
      connectorId: 'calendar',
      enabledNative: [],
    })).toEqual(['calendar']);

    expect(getEnabledNativeConnectorIdsAfterPermissionRepair({
      connectorId: 'mail',
      enabledNative: ['mail'],
    })).toEqual(['mail']);

    expect(getEnabledNativeConnectorIdsAfterPermissionRepair({
      connectorId: 'slack',
      enabledNative: [],
    })).toBeNull();
  });
});
