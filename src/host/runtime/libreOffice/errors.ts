import { installLogPath } from './layout';
import type { LibreOfficeRuntimeError, LibreOfficeRuntimeErrorCode } from './types';

function runtimeError(
  root: string,
  code: LibreOfficeRuntimeErrorCode,
  message: string,
  retryable: boolean,
): LibreOfficeRuntimeError {
  return { code, message, retryable, logPath: installLogPath(root) };
}

export function offlineError(root: string): LibreOfficeRuntimeError {
  return runtimeError(
    root,
    'LIBREOFFICE_RUNTIME_OFFLINE',
    'LibreOffice could not be downloaded because the official source and mirror are unreachable. Check the network and try again.',
    true,
  );
}

export function checksumError(root: string): LibreOfficeRuntimeError {
  return runtimeError(
    root,
    'LIBREOFFICE_RUNTIME_INSTALL_FAILED',
    'LibreOffice download verification failed. The downloaded file was removed; try again.',
    true,
  );
}

export function installFailedError(root: string): LibreOfficeRuntimeError {
  return runtimeError(
    root,
    'LIBREOFFICE_RUNTIME_INSTALL_FAILED',
    'LibreOffice installation did not finish. See the install log and try again.',
    true,
  );
}

export function unsupportedError(root: string): LibreOfficeRuntimeError {
  return runtimeError(
    root,
    'LIBREOFFICE_RUNTIME_UNSUPPORTED',
    'The managed LibreOffice runtime is supported on macOS only.',
    false,
  );
}
