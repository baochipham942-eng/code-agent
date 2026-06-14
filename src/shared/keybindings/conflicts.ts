import { KEYBINDING_DEFINITIONS } from './actions';
import { getCurrentKeybindingPlatform, mergeKeybindingsWithDefaults } from './defaults';
import { normalizeAccelerator } from './normalize';
import type {
  KeybindingConflict,
  KeybindingDefinition,
  KeybindingPlatform,
  KeybindingSystemWarning,
  KeybindingsSettings,
} from './types';

const RESERVED_ACCELERATORS: Record<KeybindingPlatform, Record<string, string>> = {
  darwin: {
    'Cmd+Space': 'macOS Spotlight 默认占用',
    'Ctrl+Space': 'macOS 输入法切换常用组合键',
    'Cmd+Tab': 'macOS 应用切换器占用',
    'Cmd+`': 'macOS 同应用窗口切换常用组合键',
    'Cmd+Shift+3': 'macOS 截取全屏占用',
    'Cmd+Shift+4': 'macOS 截取选区占用',
    'Cmd+Shift+5': 'macOS 截图工具占用',
    'Cmd+Alt+Escape': 'macOS 强制退出窗口占用',
  },
  win32: {
    'Alt+Tab': 'Windows 应用切换器占用',
    'Ctrl+Alt+Delete': 'Windows 安全选项占用',
    'Alt+F4': 'Windows 关闭窗口常用组合键',
  },
  linux: {
    'Alt+Tab': 'Linux 桌面环境通常用于应用切换',
    'Ctrl+Alt+Delete': 'Linux 桌面环境可能用于会话控制',
    'Alt+F4': 'Linux 桌面环境通常用于关闭窗口',
  },
};

export function detectKeybindingConflicts(
  settings: KeybindingsSettings | undefined,
  platform: KeybindingPlatform = getCurrentKeybindingPlatform(),
  definitions: readonly KeybindingDefinition[] = KEYBINDING_DEFINITIONS
): KeybindingConflict[] {
  const merged = mergeKeybindingsWithDefaults(settings, platform);
  const buckets = new Map<string, {
    shortcut: string;
    normalizedShortcut: string;
    scope: KeybindingConflict['scope'];
    actionIds: KeybindingConflict['actionIds'];
    labels: string[];
  }>();

  for (const definition of definitions) {
    const binding = merged.bindings[definition.id];
    if (!binding?.enabled || !binding.accelerator) continue;
    const normalizedShortcut = normalizeAccelerator(binding.accelerator, platform);
    if (!normalizedShortcut) continue;
    const bucketKey = `${definition.scope}:${normalizedShortcut}`;
    const existing = buckets.get(bucketKey);
    if (existing) {
      existing.actionIds.push(definition.id);
      existing.labels.push(definition.label);
    } else {
      buckets.set(bucketKey, {
        shortcut: binding.accelerator,
        normalizedShortcut,
        scope: definition.scope,
        actionIds: [definition.id],
        labels: [definition.label],
      });
    }
  }

  return [...buckets.values()]
    .filter((bucket) => bucket.actionIds.length > 1)
    .map((bucket) => ({
      shortcut: bucket.shortcut,
      normalizedShortcut: bucket.normalizedShortcut,
      scope: bucket.scope,
      actionIds: bucket.actionIds,
      labels: bucket.labels,
    }));
}

export function detectKeybindingSystemWarnings(
  settings: KeybindingsSettings | undefined,
  platform: KeybindingPlatform = getCurrentKeybindingPlatform(),
  definitions: readonly KeybindingDefinition[] = KEYBINDING_DEFINITIONS
): KeybindingSystemWarning[] {
  const merged = mergeKeybindingsWithDefaults(settings, platform);
  const reserved = RESERVED_ACCELERATORS[platform];
  const warnings: KeybindingSystemWarning[] = [];

  for (const definition of definitions) {
    const binding = merged.bindings[definition.id];
    if (!binding?.enabled || !binding.accelerator) continue;
    const normalizedShortcut = normalizeAccelerator(binding.accelerator, platform);
    if (!normalizedShortcut) continue;
    const reason = reserved[normalizedShortcut];
    if (!reason) continue;
    warnings.push({
      actionId: definition.id,
      label: definition.label,
      shortcut: binding.accelerator,
      normalizedShortcut,
      reason,
    });
  }

  return warnings;
}
