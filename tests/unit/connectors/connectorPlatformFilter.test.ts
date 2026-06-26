// ============================================================================
// Connector 平台过滤注册（windows-support.md §1.5 / §3.3 降级注册优化）
// 原生 connector 全组走 AppleScript，仅 macOS 可用：
//  - ConnectorRegistry 在非 darwin 平台不注册原生 connector
//  - LLM 工具列表（registerMigratedTools）在非 darwin 不出现 11 个 connector 工具
// ============================================================================

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/connectors/native/osascript', () => ({
  runAppleScript: vi.fn(async () => ''),
  escapeAppleScriptString: (value: string) => value,
  parseAppleScriptDate: () => null,
  buildAppleScriptDateVar: () => [],
  sharedAppleScriptHandlers: () => [],
}));

import { ConnectorRegistry } from '../../../src/host/connectors/registry';
import { ToolRegistry } from '../../../src/host/tools/registry';
import { registerMigratedTools } from '../../../src/host/tools/modules';
import { NATIVE_CONNECTOR_IDS } from '../../../src/shared/constants';

const CONNECTOR_TOOL_NAMES = [
  'mail',
  'mail_send',
  'mail_draft',
  'reminders',
  'reminders_create',
  'reminders_update',
  'reminders_delete',
  'calendar',
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
];

describe('ConnectorRegistry platform filtering', () => {
  it('exposes no native connector ids on win32', () => {
    const registry = new ConnectorRegistry('win32');
    expect(registry.listAvailableNativeIds()).toEqual([]);
  });

  it('ignores enabled native ids on win32 (configure registers nothing)', () => {
    const registry = new ConnectorRegistry('win32');
    registry.configure([...NATIVE_CONNECTOR_IDS]);
    expect(registry.list()).toEqual([]);
    expect(registry.get('mail')).toBeUndefined();
  });

  it('keeps darwin behaviour unchanged', () => {
    const registry = new ConnectorRegistry('darwin');
    expect(registry.listAvailableNativeIds()).toEqual(NATIVE_CONNECTOR_IDS);

    registry.configure(['mail', 'calendar']);
    expect(registry.list().map((connector) => connector.id).sort()).toEqual(['calendar', 'mail']);
  });
});

describe('connector tool registration platform filtering', () => {
  it('does not register connector tools on win32', () => {
    const registry = new ToolRegistry();
    registerMigratedTools(registry, 'win32');

    for (const name of CONNECTOR_TOOL_NAMES) {
      expect(registry.has(name), `tool "${name}" should not be registered on win32`).toBe(false);
    }
    // 平台无关工具不受影响
    expect(registry.has('Bash')).toBe(true);
    expect(registry.has('Read')).toBe(true);
  });

  it('registers connector tools on darwin', () => {
    const registry = new ToolRegistry();
    registerMigratedTools(registry, 'darwin');

    for (const name of CONNECTOR_TOOL_NAMES) {
      expect(registry.has(name), `tool "${name}" should be registered on darwin`).toBe(true);
    }
  });
});
