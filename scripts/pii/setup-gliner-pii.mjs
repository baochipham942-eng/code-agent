#!/usr/bin/env node
// ============================================================================
// GLiNER PII 一键安装脚本 (B3 ootb 流程) — Node 版，macOS / Windows 双平台
// ============================================================================
// 流程: 解析 uv binary -> 创建 venv -> 装 gliner+onnxruntime -> 下模型
//       -> 原子写入 ~/.code-agent/.env (替换已有 PII 配置, 保留其他 key)
//
// 取代原 setup-gliner-pii.sh（bash 版 Windows 跑不了，windows-support.md §2）：
// 一份实现两端用，由 pii.ipc.ts 用 process.execPath（bundled node）spawn。
//
// 调用方:
//   - dev: node scripts/pii/setup-gliner-pii.mjs
//   - packaged Neo IPC: 通过 env 传 CODE_AGENT_BUNDLED_UV / _RUNNER 指向
//     bundle resources 下的路径
//
// 每步输出以 "▷ STEP: ..." 开头便于 IPC 流式解析。错误用 "❌" 开头。
// 模型下载走系统 curl（macOS 自带；Windows 10 1803+ System32 自带）——
// 保留 .sh 版的 HTTPS_PROXY 环境变量行为（Node 原生 fetch 不读 proxy env）。
// ============================================================================

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MODEL_REPO = 'knowledgator/gliner-pii-base-v1.0';
const MODEL_BASE_URL = `https://huggingface.co/${MODEL_REPO}/resolve/main`;
const MODEL_FILES = [
  'gliner_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'added_tokens.json',
  'spm.model',
];

// ---------------------------------------------------------------------------
// 可测纯函数（tests/unit/scripts/setupGlinerPii.test.ts）
// ---------------------------------------------------------------------------

/** venv 内 python 路径：POSIX bin/python，Windows Scripts/python.exe */
export function venvPythonPath(venvDir, platform = process.platform) {
  return platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

/** uv 二进制文件名按平台 */
export function uvBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'uv.exe' : 'uv';
}

/**
 * 重写 .env 内容：剔除已有 PII 配置行（与 .sh 版同一 regex 语义），
 * 保留其他 key，追加新的 PII 配置块。
 */
export function buildEnvContent(existingContent, piiVars) {
  const kept = (existingContent ?? '')
    .split('\n')
    .filter((line) => !/^CODE_AGENT_(PII_ENTITY|GLINER_PII)/.test(line));
  // 去掉尾部空行，保持输出整洁（与 .sh 版 grep 行为一致：保留中间空行）
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  const lines = [...kept, ...Object.entries(piiVars).map(([key, value]) => `${key}=${value}`)];
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function step(message) {
  console.log(`▷ STEP: ${message}`);
}

function fail(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

function isExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function resolveUvBinary(rootDir) {
  const bundled = process.env.CODE_AGENT_BUNDLED_UV;
  if (bundled && isExecutable(bundled)) return bundled;
  const devUv = path.join(rootDir, 'scripts', uvBinaryName());
  if (isExecutable(devUv)) return devUv;
  // system PATH 兜底
  try {
    const probe = process.platform === 'win32' ? ['where', ['uv']] : ['command', ['-v', 'uv']];
    const out = process.platform === 'win32'
      ? execFileSync(probe[0], probe[1], { encoding: 'utf8' })
      : execFileSync('sh', ['-c', 'command -v uv'], { encoding: 'utf8' });
    const found = out.split('\n')[0]?.trim();
    if (found && isExecutable(found)) return found;
  } catch {
    // ignore
  }
  return null;
}

/** 静默跑命令，失败时打印日志尾部（对应 .sh 版 run_quiet） */
async function runQuiet(label, command, args) {
  try {
    await execFileAsync(command, args, { maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    fail(`${label} 失败`);
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    const tail = output.split('\n').slice(-40).join('\n');
    if (tail.trim()) console.error(tail);
    throw error;
  }
}

async function downloadIfMissing(remotePath, target) {
  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    step(`模型分片已存在,跳过 (${path.basename(target)})`);
    return;
  }
  step(`下载模型分片 ${path.basename(target)}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmpTarget = `${target}.tmp.${process.pid}`;
  try {
    await execFileAsync('curl', [
      '--silent', '--show-error', '-L', '--fail',
      '--retry', '3', '--retry-delay', '2',
      '-o', tmpTarget,
      `${MODEL_BASE_URL}/${remotePath}`,
    ], { maxBuffer: 4 * 1024 * 1024 });
    fs.renameSync(tmpTarget, target);
    console.log(`✓ 下载完成 ${path.basename(target)}`);
  } catch (error) {
    fs.rmSync(tmpTarget, { force: true });
    fail(`下载 ${remotePath} 失败: ${error.stderr ?? error.message}`);
    throw error;
  }
}

export async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const cacheDir = process.env.CODE_AGENT_GLINER_PII_CACHE
    || path.join(os.homedir(), '.cache', 'code-agent', 'gliner-pii');
  const venvDir = path.join(cacheDir, '.venv');
  const modelDir = process.env.CODE_AGENT_GLINER_PII_MODEL
    || path.join(cacheDir, 'models', 'knowledgator-gliner-pii-base-v1.0');
  const onnxFile = process.env.CODE_AGENT_GLINER_PII_INSTALL_ONNX_FILE || 'onnx/model_quint8.onnx';
  const envFile = path.join(os.homedir(), '.code-agent', '.env');

  const uvBin = resolveUvBinary(rootDir);
  if (!uvBin) {
    fail('找不到 uv binary。运行 bash scripts/fetch-uv.sh 先拉取,或装系统 uv。');
    return 1;
  }

  const runnerPath = process.env.CODE_AGENT_BUNDLED_RUNNER
    || path.join(rootDir, 'scripts', 'pii', 'gliner_onnx_runner.py');
  if (!fs.existsSync(runnerPath)) {
    fail(`gliner_onnx_runner.py 缺失: ${runnerPath}`);
    return 1;
  }

  step(`解析依赖 (uv=${uvBin}, runner=${runnerPath})`);

  fs.mkdirSync(path.join(modelDir, path.dirname(onnxFile)), { recursive: true });
  step(`创建 Python 3.12 venv (${venvDir})`);
  await runQuiet('创建 Python 3.12 venv', uvBin, ['venv', '--allow-existing', '--python', '3.12', venvDir]);

  const venvPython = venvPythonPath(venvDir);
  step('安装 gliner + onnxruntime');
  await runQuiet('安装 gliner + onnxruntime', uvBin, [
    'pip', 'install', '--python', venvPython, 'gliner==0.2.26', 'onnxruntime>=1.18,<2',
  ]);

  for (const file of MODEL_FILES) {
    await downloadIfMissing(file, path.join(modelDir, file));
  }
  await downloadIfMissing(onnxFile, path.join(modelDir, onnxFile));

  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(runnerPath, 0o755);
    } catch {
      // bundle 内只读资源时忽略（runner 由 venv python 解释执行，无需可执行位）
    }
  }

  // 原子写入 ~/.code-agent/.env（webServer 启动时读取并 export，见 CLAUDE.md）
  step(`写入 ${envFile}`);
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const content = buildEnvContent(existing, {
    CODE_AGENT_PII_ENTITY_DETECTOR: 'gliner-onnx-command',
    CODE_AGENT_GLINER_PII_COMMAND: runnerPath,
    CODE_AGENT_GLINER_PII_RUNNER_PYTHON: venvPython,
    CODE_AGENT_GLINER_PII_MODEL: modelDir,
    CODE_AGENT_GLINER_PII_ONNX_FILE: onnxFile,
    CODE_AGENT_PII_ENTITY_TIMEOUT_MS: '30000',
  });
  const tmpEnv = `${envFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmpEnv, content);
  fs.renameSync(tmpEnv, envFile);

  step('完成。重启 Neo 后本地 PII 防线生效。');
  return 0;
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  main().then(
    (code) => { process.exitCode = code ?? 0; },
    () => { process.exitCode = process.exitCode || 1; },
  );
}
