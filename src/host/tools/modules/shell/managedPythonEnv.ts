// ============================================================================
// Managed Python env（NEO_PYTHON 注入 + 未装 fail-closed）— N-PY-RUNTIME-K2
//
// 把 K1 的托管 Python 暴露给 agent 的 shell 子进程，挂在 createEvalSafeShellEnv
// 尾部（bash 前台/后台/PTY 三条路径共用）：
//   已装 ⇒ env 只多一个 NEO_PYTHON=<venv python 绝对路径>，其余逐字节不变；
//          用户 PATH 永不被改写，NEO_PYTHON 永不指向系统 python。
//   未装 ⇒ 命令不引用 NEO_PYTHON 时环境原样放行（不触发安装）；引用时
//          fail-closed 不 exec——结构化 code + 白话说明，后台经 ensurePythonEnv
//          按需安装（K1 inflight 单飞：安装期间再次调用不再 kick）。
// ============================================================================

import type { ToolContext } from '../../../protocol/tools';
import { ensurePythonEnv } from '../../../runtime/pythonEnv/ensure';
import { getManagedPythonPath, getPythonEnvState } from '../../../runtime/pythonEnv/state';
import type { PythonRuntimeError, PythonRuntimeErrorCode } from '../../../runtime/pythonEnv/types';

type ManagedPythonEnvCode = 'PYTHON_RUNTIME_INSTALLING' | PythonRuntimeErrorCode;

export interface ManagedPythonEnvBlock {
  ok: false;
  code: ManagedPythonEnvCode;
  error: string;
}

const FIRST_INSTALL_HINT =
  'Neo is downloading its managed Python (pandas/openpyxl/python-pptx/python-docx/pdfplumber included); ' +
  'a first install usually takes one to three minutes. This command was not run. ' +
  'Re-run it after the install finishes.';

function installingMessage(percent: number | undefined): string {
  if (percent === undefined) return FIRST_INSTALL_HINT;
  return `Neo is installing its managed Python — ${Math.round(percent)}% done. ` +
    'This command was not run. Re-run it after the install finishes.';
}

function failedMessage(error: PythonRuntimeError): string {
  return `${error.message} Retry from Settings → Local capabilities, or re-run this command to start another install attempt.`;
}

/**
 * 已装 ⇒ 原地注入 env.NEO_PYTHON 并返回 null；未装且命令引用 NEO_PYTHON ⇒
 * 返回 fail-closed 结构化错误（并按需 kick 一次后台安装）。其余情况原样放行。
 */
export function applyManagedPython(
  env: Record<string, string>,
  command: string,
  logger?: ToolContext['logger'],
): ManagedPythonEnvBlock | null {
  const managedPath = getManagedPythonPath();
  if (managedPath) {
    env.NEO_PYTHON = managedPath;
    return null;
  }
  if (!/\bNEO_PYTHON\b/.test(command)) return null;

  const state = getPythonEnvState();
  if (state.phase === 'unsupported' && state.error) {
    return { ok: false, code: state.error.code, error: state.error.message };
  }
  if (state.phase === 'missing' || state.phase === 'failed') {
    // 单飞在 K1（inflight map）：同 root 同时只有一次安装；已失败时再 kick 即
    // 「re-run 重试」。结果落 install.log，失败经下次 getPythonEnvState 可见。
    logger?.info('Managed Python referenced before install; kicking background install');
    void ensurePythonEnv().then(
      (result) => {
        if (!result.ok) logger?.warn('Managed Python background install failed', { code: result.error.code });
      },
      (error: unknown) => {
        logger?.warn('Managed Python background install threw', {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }
  if (state.phase === 'failed' && state.error) {
    return { ok: false, code: state.error.code, error: failedMessage(state.error) };
  }
  return {
    ok: false,
    code: 'PYTHON_RUNTIME_INSTALLING',
    error: installingMessage(state.phase === 'installing' ? state.percent : undefined),
  };
}
