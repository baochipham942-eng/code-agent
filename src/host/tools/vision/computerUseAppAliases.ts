export interface ComputerActionAliasTarget {
  action: string;
  targetApp?: string;
  requestedTargetApp?: string;
  targetAppAliasApplied?: boolean;
}

const MACOS_APP_ALIASES = new Map<string, string>([
  ['notepad', 'Notes'],
  ['note', 'Notes'],
  ['notes', 'Notes'],
  ['applenotes', 'Notes'],
  ['记事本', 'Notes'],
  ['备忘录', 'Notes'],
  ['備忘錄', 'Notes'],
  ['textedit', 'TextEdit'],
  ['texteditor', 'TextEdit'],
  ['文本编辑', 'TextEdit'],
  ['文本编辑器', 'TextEdit'],
  ['文字编辑', 'TextEdit'],
  ['纯文本编辑器', 'TextEdit'],
]);

function normalizeAppAliasKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s._-]+/g, '');
}

export function resolveMacOSApplicationAlias(targetApp: string): string {
  const key = normalizeAppAliasKey(targetApp);
  return MACOS_APP_ALIASES.get(key) || targetApp;
}

export function normalizeComputerActionAliases<T extends ComputerActionAliasTarget>(action: T): T {
  if (process.platform !== 'darwin' || action.action !== 'open_application' || typeof action.targetApp !== 'string') {
    return action;
  }
  const resolvedTargetApp = resolveMacOSApplicationAlias(action.targetApp);
  if (resolvedTargetApp === action.targetApp) {
    return action;
  }
  return {
    ...action,
    targetApp: resolvedTargetApp,
    requestedTargetApp: action.targetApp,
    targetAppAliasApplied: true,
  };
}
