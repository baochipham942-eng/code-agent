import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import type { InferenceSession, Tensor as OrtTensor, TensorConstructor } from 'onnxruntime-node';
import { resolveExistingNodeModule } from '../../runtime/runtimeAssetResolver';

const runtimeRequire = typeof require === 'function' ? require : createRequire(import.meta.url);

export interface OrtRuntimeModule {
  InferenceSession: {
    create(modelPath: string): Promise<InferenceSession>;
  };
  Tensor: TensorConstructor;
}

export type VadRuntimeLoadResult =
  | { ok: true; ort: OrtRuntimeModule; modelPath: string }
  | { ok: false; reason: 'missing-runtime' | 'missing-model'; modelPath?: string; tauriNodeModules: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 取一个「可以带属性的值」——**对象和函数都算**。
 *
 * 🔴 2026-08-14 真机腿：原来这里用 `isRecord`（只认 typeof 'object'），而
 * onnxruntime-node 的 `InferenceSession` 是个 **class**（typeof 'function'），
 * 于是判定恒为 false，模块明明 require 成功却被判成「不是 ORT 运行时」。
 * 实测：`require(<资产路径>)` 返回 InferenceSession/Tensor 都是 function，
 * `InferenceSession.create` 也在 —— 能力齐备，只是被类型判据挡在门外。
 * 影响面不止声纹：桌面 VAD 走的是同一条装载链。
 */
function readCallableOrRecordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  if (typeof value === 'function') return value as unknown as Record<string, unknown>;
  return isRecord(value) ? value : undefined;
}

function isOrtRuntimeModule(value: unknown): value is OrtRuntimeModule {
  if (!isRecord(value)) return false;
  const inferenceSession = readCallableOrRecordField(value, 'InferenceSession');
  return !!inferenceSession
    && typeof inferenceSession.create === 'function'
    && typeof value.Tensor === 'function';
}

function loadOrtRuntimeModule(modulePath?: string): OrtRuntimeModule | null {
  const loaded: unknown = modulePath ? runtimeRequire(modulePath) : runtimeRequire('onnxruntime-node');
  return isOrtRuntimeModule(loaded) ? loaded : null;
}

export function isOrtTensor(value: unknown): value is OrtTensor {
  return isRecord(value) && 'data' in value && 'dims' in value && 'type' in value;
}

function loadOrtRuntime(tauriNodeModules: string, cwdNodeModules: string): OrtRuntimeModule | null {
  const resolvedOrtPath = resolveExistingNodeModule('onnxruntime-node');
  for (const candidate of [resolvedOrtPath ?? undefined, undefined]) {
    try {
      const ort = loadOrtRuntimeModule(candidate);
      if (ort) return ort;
    } catch {
      // Try the next source.
    }
  }

  for (const nm of [tauriNodeModules, cwdNodeModules]) {
    const ortPath = path.join(nm, 'onnxruntime-node');
    if (fs.existsSync(ortPath)) return loadOrtRuntimeModule(ortPath);
  }
  return null;
}

function resolveVadModelPath(tauriNodeModules: string, cwdNodeModules: string): string {
  const resolvedVadModulePath = resolveExistingNodeModule('avr-vad');
  if (resolvedVadModulePath) {
    const resolvedVadModelPath = path.join(resolvedVadModulePath, 'dist', 'silero_vad_v5.onnx');
    if (fs.existsSync(resolvedVadModelPath)) return resolvedVadModelPath;
  }

  try {
    return path.join(path.dirname(runtimeRequire.resolve('avr-vad')), 'silero_vad_v5.onnx');
  } catch {
    for (const nm of [tauriNodeModules, cwdNodeModules]) {
      const candidate = path.join(nm, 'avr-vad', 'dist', 'silero_vad_v5.onnx');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return '';
}

/**
 * 只要 ONNX 运行时不要 VAD 模型（声纹 embedding 走这里，同一份 runtime asset）。
 *
 * 与 loadOrtRuntime 的区别是**把失败原因带出来**：那边一路 try/catch 吞异常，
 * 上层只看得到 null，现场无法区分「资产没装」和「装了但 require 炸了」——
 * 2026-08-14 真机腿就卡在这个区分上（资产明明在 active.json 里且文件存在）。
 */
export function loadOrtRuntimeForModule(
  moduleDir: string,
  cwd = process.cwd(),
): { ort: OrtRuntimeModule | null; attempts: Array<{ path: string; error: string }> } {
  const attempts: Array<{ path: string; error: string }> = [];
  const resolved = resolveExistingNodeModule('onnxruntime-node');
  const candidates: Array<string | undefined> = [
    resolved ?? undefined,
    path.join(moduleDir, '..', '..', 'node_modules', 'onnxruntime-node'),
    path.join(cwd, 'node_modules', 'onnxruntime-node'),
    undefined,
  ];
  for (const candidate of candidates) {
    try {
      const ort = loadOrtRuntimeModule(candidate);
      if (ort) return { ort, attempts };
      attempts.push({ path: candidate ?? '(bare specifier)', error: 'loaded but shape mismatch' });
    } catch (error) {
      attempts.push({
        path: candidate ?? '(bare specifier)',
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
  return { ort: null, attempts };
}

export function loadVadRuntime(moduleDir: string, cwd = process.cwd()): VadRuntimeLoadResult {
  const tauriNodeModules = path.join(moduleDir, '..', '..', 'node_modules');
  const cwdNodeModules = path.join(cwd, 'node_modules');
  const ort = loadOrtRuntime(tauriNodeModules, cwdNodeModules);
  if (!ort) return { ok: false, reason: 'missing-runtime', tauriNodeModules };

  const modelPath = resolveVadModelPath(tauriNodeModules, cwdNodeModules);
  if (!modelPath || !fs.existsSync(modelPath)) {
    return { ok: false, reason: 'missing-model', modelPath, tauriNodeModules };
  }

  return { ok: true, ort, modelPath };
}
