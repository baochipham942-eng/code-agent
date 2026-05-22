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

function readRecordField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function isOrtRuntimeModule(value: unknown): value is OrtRuntimeModule {
  if (!isRecord(value)) return false;
  const inferenceSession = readRecordField(value, 'InferenceSession');
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
