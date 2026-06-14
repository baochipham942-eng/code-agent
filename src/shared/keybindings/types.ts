export type KeybindingPlatform = 'darwin' | 'win32' | 'linux';

export type KeybindingScope =
  | 'global'
  | 'session'
  | 'composer'
  | 'artifact'
  | 'workbench'
  | 'settings';

export type KeybindingCategory =
  | 'global'
  | 'sessionEditing'
  | 'delivery'
  | 'workbench'
  | 'settings';

export type KeybindingRisk = 'safe' | 'destructive' | 'expensive' | 'advanced';

export type KeybindingActionId =
  | 'app.toggle'
  | 'app.quickAsk'
  | 'session.new'
  | 'voice.toggle'
  | 'appshot.capture'
  | 'composer.send'
  | 'composer.newline'
  | 'composer.focus'
  | 'composer.slashMenu'
  | 'commandPalette.open'
  | 'session.stop'
  | 'session.continue'
  | 'session.retry'
  | 'session.compact'
  | 'session.clear'
  | 'session.previous'
  | 'session.next'
  | 'session.moveToBackground'
  | 'settings.open'
  | 'artifacts.open'
  | 'artifacts.preview'
  | 'artifacts.export'
  | 'artifacts.copy'
  | 'artifacts.previousVersion'
  | 'artifacts.nextVersion'
  | 'sidebar.toggle'
  | 'dag.toggle'
  | 'workspace.toggle'
  | 'statusRail.toggle'
  | 'browser.open'
  | 'computerUse.open'
  | 'replay.open'
  | 'reviewQueue.open'
  | 'files.attach'
  | 'settings.keybindings'
  | 'settings.mcp'
  | 'settings.skills'
  | 'settings.plugins'
  | 'settings.usage';

export interface KeybindingDefinition {
  id: KeybindingActionId;
  label: string;
  description: string;
  category: KeybindingCategory;
  scope: KeybindingScope;
  configurable: boolean;
  enabledByDefault: boolean;
  defaultHotkeys: Partial<Record<KeybindingPlatform, string | null>>;
  risk?: KeybindingRisk;
}

export interface KeybindingSetting {
  enabled: boolean;
  accelerator: string | null;
}

export interface KeybindingsSettings {
  version: 1;
  platform?: KeybindingPlatform;
  globalHotkeysEnabled?: boolean;
  bindings: Partial<Record<KeybindingActionId, KeybindingSetting>>;
}

export interface KeybindingConflict {
  shortcut: string;
  normalizedShortcut: string;
  scope: KeybindingScope;
  actionIds: KeybindingActionId[];
  labels: string[];
}

export interface KeybindingSystemWarning {
  actionId: KeybindingActionId;
  label: string;
  shortcut: string;
  normalizedShortcut: string;
  reason: string;
}
