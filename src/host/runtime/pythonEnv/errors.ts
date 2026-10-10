import { installLogPath } from './layout';
import type { PythonRuntimeError, PythonRuntimeErrorCode } from './types';

function runtimeError(
  root: string,
  code: PythonRuntimeErrorCode,
  message: string,
  retryable: boolean,
): PythonRuntimeError {
  return { code, message, retryable, logPath: installLogPath(root) };
}

export function offlineError(root: string): PythonRuntimeError {
  return runtimeError(
    root,
    'PYTHON_RUNTIME_OFFLINE',
    'Python runtime install needs a package index, but both PyPI and the mirror are unreachable. Check the network and try again.',
    true,
  );
}

export function installFailedError(root: string): PythonRuntimeError {
  return runtimeError(
    root,
    'PYTHON_RUNTIME_INSTALL_FAILED',
    'Python runtime install failed. See the install log and try again.',
    true,
  );
}

export function unsupportedError(root: string): PythonRuntimeError {
  return runtimeError(
    root,
    'PYTHON_RUNTIME_UNSUPPORTED',
    'The managed Python runtime is not supported on Windows.',
    false,
  );
}
