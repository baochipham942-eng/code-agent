import { execFile } from 'child_process';
import path from 'path';
import { resolveHelperBinary } from '../runtimeAssetResolver';

const STRIPPED_ENV_KEYS = ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA_PREFIX'] as const;

export function buildUvEnv(options: {
  root: string;
  parentEnv: NodeJS.ProcessEnv;
  mirror: string | null;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...options.parentEnv };
  // uv otherwise links a python shim into the user bin dir (~/.local/bin).
  env.UV_PYTHON_INSTALL_BIN = '0';
  env.UV_PYTHON_PREFERENCE = 'only-managed';
  env.UV_NO_CONFIG = '1';
  env.UV_CACHE_DIR = path.join(options.root, 'cache');
  env.UV_PYTHON_INSTALL_DIR = path.join(options.root, 'interpreters');
  for (const key of STRIPPED_ENV_KEYS) delete env[key];
  if (options.mirror) env.UV_PYTHON_INSTALL_MIRROR = options.mirror;
  else delete env.UV_PYTHON_INSTALL_MIRROR;
  return env;
}

function exitCode(err: (Error & { code?: unknown; status?: unknown }) | null): number {
  if (!err) return 0;
  if (typeof err.code === 'number') return err.code;
  if (typeof err.status === 'number') return err.status;
  return 1;
}

export function defaultRunUv(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stderr: string }> {
  const uvBin = resolveHelperBinary('uv');
  return new Promise((resolve) => {
    execFile(uvBin, args, {
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }, (err, _stdout, stderr) => {
      resolve({
        code: exitCode(err),
        stderr: typeof stderr === 'string' ? stderr : '',
      });
    });
  });
}
