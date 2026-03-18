// ============================================================================
// Platform: App Paths & Lifecycle - 替代 Electron app 模块
// ============================================================================

import os from 'os';
import path from 'path';
import { readFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

let _userDataPath: string | null = null;

export function getUserDataPath(): string {
  if (_userDataPath) return _userDataPath;
  _userDataPath = process.env.CODE_AGENT_DATA_DIR
    || path.join(os.homedir(), '.code-agent');
  return _userDataPath;
}

export function getHomePath(): string {
  return os.homedir();
}

export function getTempPath(): string {
  return os.tmpdir();
}

export function getAppDataPath(): string {
  return os.homedir();
}

export function getDocumentsPath(): string {
  return path.join(os.homedir(), 'Documents');
}

export function getDesktopPath(): string {
  return path.join(os.homedir(), 'Desktop');
}

export function getDownloadsPath(): string {
  return path.join(os.homedir(), 'Downloads');
}

export function getLogsPath(): string {
  return path.join(getUserDataPath(), 'logs');
}

/**
 * 通用 getPath — 兼容现有 app.getPath(name) 调用模式
 */
export function getPath(name: string): string {
  switch (name) {
    case 'userData': return getUserDataPath();
    case 'home': return getHomePath();
    case 'temp': return getTempPath();
    case 'appData': return getAppDataPath();
    case 'documents': return getDocumentsPath();
    case 'desktop': return getDesktopPath();
    case 'downloads': return getDownloadsPath();
    case 'logs': return getLogsPath();
    default: return getTempPath();
  }
}

// ---------------------------------------------------------------------------
// App metadata
// ---------------------------------------------------------------------------

let _appVersion: string | null = null;

export function getAppVersion(): string {
  if (_appVersion) return _appVersion;
  try {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    _appVersion = pkg.version || '0.0.0';
  } catch {
    // Fallback: try from process.cwd()
    try {
      const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
      _appVersion = pkg.version || '0.0.0';
    } catch {
      _appVersion = '0.0.0';
    }
  }
  return _appVersion!;
}

export function getAppName(): string {
  return 'code-agent';
}

export function isPackaged(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function getAppPath(): string {
  return process.cwd();
}

export function getLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  } catch {
    return 'en-US';
  }
}

// ---------------------------------------------------------------------------
// app 兼容对象 — 提供与 electronMock.app 相同接口，方便渐进迁移
// ---------------------------------------------------------------------------

export const app = {
  getPath,
  getVersion: getAppVersion,
  getName: getAppName,
  isReady: () => true,
  isPackaged: isPackaged(),
  getAppPath,
  getLocale,
  commandLine: { appendSwitch: (..._args: unknown[]) => {} },
  on: (..._args: unknown[]) => app,
  once: (..._args: unknown[]) => app,
  off: (..._args: unknown[]) => app,
  removeListener: (..._args: unknown[]) => app,
  removeAllListeners: (..._args: unknown[]) => app,
  emit: (..._args: unknown[]) => false,
  quit: () => { process.exit(0); },
  exit: (code = 0) => { process.exit(code); },
  requestSingleInstanceLock: () => true,
  setAppUserModelId: (..._args: unknown[]) => {},
  setAsDefaultProtocolClient: (..._args: unknown[]) => false as boolean,
  setPath: (..._args: unknown[]) => {},
  whenReady: () => Promise.resolve(),
};
