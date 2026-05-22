import type sharpImport from 'sharp';
import type { RuntimeAssetResolverOptions } from './runtimeAssetResolver';
import { requireOptionalNodeModule } from './nodeModuleLoader';

export type SharpModule = typeof sharpImport;

export interface SharpLoadOptions extends RuntimeAssetResolverOptions {
  allowBareModule?: boolean;
}

export interface SharpLoadResult {
  ok: boolean;
  sharp?: SharpModule;
  error?: string;
  missingPackage?: boolean;
}

function normalizeSharpModule(value: unknown): SharpModule | null {
  const candidate = typeof value === 'function'
    ? value
    : typeof (value as { default?: unknown } | null)?.default === 'function'
      ? (value as { default: unknown }).default
      : null;

  if (!candidate || typeof candidate !== 'function') return null;
  return candidate as SharpModule;
}

export function loadSharp(options: SharpLoadOptions = {}): SharpLoadResult {
  const loaded = requireOptionalNodeModule<unknown>('sharp', options);
  if (!loaded.ok) {
    return {
      ok: false,
      error: loaded.missingPackage
        ? 'Sharp image runtime is unavailable; install image processing components before using this feature.'
        : loaded.error,
      missingPackage: loaded.missingPackage,
    };
  }

  const sharp = normalizeSharpModule(loaded.module);
  if (!sharp) {
    return {
      ok: false,
      error: `Sharp package loaded from ${loaded.path ?? 'unknown'} does not export a callable image processor.`,
      missingPackage: false,
    };
  }

  return { ok: true, sharp };
}

export function requireSharp(options: SharpLoadOptions = {}): SharpModule {
  const loaded = loadSharp(options);
  if (!loaded.ok || !loaded.sharp) {
    throw new Error(loaded.error ?? 'Sharp image runtime is unavailable.');
  }
  return loaded.sharp;
}
