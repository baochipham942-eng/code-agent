// ============================================================================
// PII 防线 IPC Handlers (domain:pii) — B3 一键启用本地 PII 防线
//
// 流程: renderer 调 setup:start → spawn scripts/pii/setup-gliner-pii.sh
//   → 流式 stdout/stderr 通过 IPC_CHANNELS.PII_SETUP_EVENT 推 renderer
//   → 脚本完成后写入 ~/.code-agent/.env (脚本自己做的)
//   → renderer 调 setup:isReady 校验配置已生效
//
// bundle 路径解析跟 rtkRewriter/ocrSearch 同模式: dev 走 scripts/, packaged
// 走 Resources/_up_/scripts/。bundled uv 通过 CODE_AGENT_BUNDLED_UV env
// 传给脚本,脚本不再依赖 system uv/Python。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, type ChildProcess } from 'child_process';
import type { IpcMain } from '../platform';
import { broadcastToRenderer } from '../platform';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('PiiIpc');

type SetupState = 'idle' | 'running' | 'completed' | 'error';
type SetupEvent =
  | { type: 'log'; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'step'; description: string }
  | { type: 'state'; state: SetupState; error?: string };

interface SetupRuntime {
  state: SetupState;
  child: ChildProcess | null;
  startedAt: number | null;
  lastError: string | null;
  logBuffer: Array<{ stream: 'stdout' | 'stderr'; line: string; ts: number }>;
}

const runtime: SetupRuntime = {
  state: 'idle',
  child: null,
  startedAt: null,
  lastError: null,
  logBuffer: [],
};

const MAX_LOG_BUFFER = 500;

function publish(event: SetupEvent): void {
  broadcastToRenderer(IPC_CHANNELS.PII_SETUP_EVENT, event);
}

function appendLog(stream: 'stdout' | 'stderr', line: string): void {
  runtime.logBuffer.push({ stream, line, ts: Date.now() });
  if (runtime.logBuffer.length > MAX_LOG_BUFFER) {
    runtime.logBuffer.splice(0, runtime.logBuffer.length - MAX_LOG_BUFFER);
  }
  publish({ type: 'log', stream, line });
  // STEP 行单独 emit 给 UI 显示当前阶段
  if (stream === 'stdout' && line.startsWith('▷ STEP:')) {
    publish({ type: 'step', description: line.replace(/^▷ STEP:\s*/, '').trim() });
  }
}

function setState(state: SetupState, error?: string): void {
  runtime.state = state;
  runtime.lastError = error ?? null;
  publish({ type: 'state', state, error });
}

// ---------------------------------------------------------------------------
// bundle 路径解析 (dev / packaged)
// ---------------------------------------------------------------------------
function findBundledFile(relativeFromScripts: string): string | null {
  const candidates: string[] = [];
  // dev: scripts/
  candidates.push(path.join(__dirname, '..', '..', '..', '..', '..', 'scripts', relativeFromScripts));
  candidates.push(path.join(__dirname, '..', '..', '..', '..', 'scripts', relativeFromScripts));
  candidates.push(path.join(__dirname, '..', '..', '..', 'scripts', relativeFromScripts));
  // packaged: Resources/_up_/scripts/ or Resources/scripts/
  candidates.push(path.join(__dirname, '..', '..', 'scripts', relativeFromScripts));
  candidates.push(path.join(__dirname, '..', 'scripts', relativeFromScripts));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      // ignore
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// isReady 检测: env vars 在 ~/.code-agent/.env + venv python + model.onnx 都到位
// ---------------------------------------------------------------------------
interface ReadyStatus {
  ready: boolean;
  envFile: { exists: boolean; hasPiiKeys: boolean };
  pythonPath: string | null;
  modelOnnx: string | null;
}

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return result;
}

function checkReady(): ReadyStatus {
  const envFilePath = path.join(os.homedir(), '.code-agent', '.env');
  let envExists = false;
  let env: Record<string, string> = {};
  try {
    if (fs.existsSync(envFilePath)) {
      envExists = true;
      env = parseEnvFile(fs.readFileSync(envFilePath, 'utf-8'));
    }
  } catch {
    // ignore
  }
  const detector = env.CODE_AGENT_PII_ENTITY_DETECTOR;
  const pythonPath = env.CODE_AGENT_GLINER_PII_RUNNER_PYTHON || null;
  const modelDir = env.CODE_AGENT_GLINER_PII_MODEL || null;
  const onnxFile = env.CODE_AGENT_GLINER_PII_ONNX_FILE || 'onnx/model.onnx';
  const modelOnnx = modelDir ? path.join(modelDir, onnxFile) : null;

  const hasPiiKeys = detector === 'gliner-onnx-command' && !!pythonPath && !!modelDir;
  const pythonExists = pythonPath ? fs.existsSync(pythonPath) : false;
  const onnxExists = modelOnnx ? fs.existsSync(modelOnnx) : false;

  return {
    ready: envExists && hasPiiKeys && pythonExists && onnxExists,
    envFile: { exists: envExists, hasPiiKeys },
    pythonPath: pythonExists ? pythonPath : null,
    modelOnnx: onnxExists ? modelOnnx : null,
  };
}

// ---------------------------------------------------------------------------
// setup:start
// ---------------------------------------------------------------------------
function startSetup(): { started: boolean; error?: string } {
  if (runtime.state === 'running') {
    return { started: false, error: '已有 setup 任务在跑,等它完成或先 cancel' };
  }

  const setupScript = findBundledFile(path.join('pii', 'setup-gliner-pii.sh'));
  const uvBinary = findBundledFile('uv');
  const runnerScript = findBundledFile(path.join('pii', 'gliner_onnx_runner.py'));

  if (!setupScript) {
    return { started: false, error: 'setup-gliner-pii.sh 未找到 (检查 bundle resources)' };
  }
  if (!uvBinary) {
    return { started: false, error: 'uv binary 未找到 (运行 bash scripts/fetch-uv.sh)' };
  }
  if (!runnerScript) {
    return { started: false, error: 'gliner_onnx_runner.py 未找到 (检查 bundle resources)' };
  }

  runtime.logBuffer = [];
  runtime.startedAt = Date.now();
  setState('running');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODE_AGENT_BUNDLED_UV: uvBinary,
    CODE_AGENT_BUNDLED_RUNNER: runnerScript,
  };

  const child = spawn('bash', [setupScript], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  runtime.child = child;

  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const flushBuf = (buf: string[], stream: 'stdout' | 'stderr', chunk: string): void => {
    buf.push(chunk);
    const joined = buf.join('');
    const lines = joined.split('\n');
    buf.length = 0;
    buf.push(lines.pop() ?? ''); // 不完整行留到下次
    for (const line of lines) {
      if (line.length > 0) appendLog(stream, line);
    }
  };

  child.stdout?.on('data', (data: Buffer) => flushBuf(stdoutBuf, 'stdout', data.toString('utf-8')));
  child.stderr?.on('data', (data: Buffer) => flushBuf(stderrBuf, 'stderr', data.toString('utf-8')));

  child.on('error', (err) => {
    logger.error('pii setup spawn error', { error: err.message });
    setState('error', `spawn 失败: ${err.message}`);
    runtime.child = null;
  });

  child.on('close', (code, signal) => {
    // 冲刷残留 buffer
    if (stdoutBuf.join('').length > 0) appendLog('stdout', stdoutBuf.join(''));
    if (stderrBuf.join('').length > 0) appendLog('stderr', stderrBuf.join(''));
    runtime.child = null;

    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      setState('error', `任务被取消 (${signal})`);
      return;
    }
    if (code === 0) {
      setState('completed');
    } else {
      setState('error', `脚本退出码 ${code}`);
    }
  });

  return { started: true };
}

function cancelSetup(): { cancelled: boolean } {
  if (runtime.state !== 'running' || !runtime.child) return { cancelled: false };
  try {
    runtime.child.kill('SIGTERM');
  } catch {
    // ignore
  }
  return { cancelled: true };
}

function getStatus() {
  return {
    state: runtime.state,
    startedAt: runtime.startedAt,
    error: runtime.lastError,
    logTail: runtime.logBuffer.slice(-100),
  };
}

// ---------------------------------------------------------------------------
// IPC handler 注册
// ---------------------------------------------------------------------------
export function registerPiiHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_DOMAINS.PII, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action } = request;
    try {
      let data: unknown;
      switch (action) {
        case 'setup:start':
          data = startSetup();
          break;
        case 'setup:cancel':
          data = cancelSetup();
          break;
        case 'setup:status':
          data = getStatus();
          break;
        case 'setup:isReady':
          data = checkReady();
          break;
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` } };
      }
      return { success: true, data };
    } catch (error) {
      logger.error('pii ipc handler error', { action, error: error instanceof Error ? error.message : String(error) });
      return {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) },
      };
    }
  });
  logger.info('PII IPC handlers registered');
}
