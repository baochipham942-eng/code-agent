import type { RuntimeAssetResolverOptions } from './runtimeAssetResolver';
import { requireOptionalNodeModule } from './nodeModuleLoader';

type PlaywrightModule = typeof import('playwright');

export interface PlaywrightLoadOptions extends RuntimeAssetResolverOptions {
  allowBareModule?: boolean;
  prepareRuntimeAsset?: (assetId: 'playwright-browser-runtime') => Promise<void>;
}

export interface PlaywrightLoadResult {
  ok: boolean;
  module?: PlaywrightModule;
  error?: string;
  missingPackage?: boolean;
}

export interface PlaywrightChromiumLoadResult {
  ok: boolean;
  chromium?: PlaywrightModule['chromium'];
  error?: string;
  missingPackage?: boolean;
}

function isPlaywrightModule(value: unknown): value is PlaywrightModule {
  return Boolean(value && typeof value === 'object' && 'chromium' in value);
}

export async function loadPlaywright(options: PlaywrightLoadOptions = {}): Promise<PlaywrightLoadResult> {
  let loaded = requireOptionalNodeModule<unknown>('playwright', options);
  if (!loaded.ok && loaded.missingPackage) {
    try {
      if (options.prepareRuntimeAsset) {
        await options.prepareRuntimeAsset('playwright-browser-runtime');
        loaded = requireOptionalNodeModule<unknown>('playwright', options);
      } else {
        const { isUpdateServiceInitialized, prepareRuntimeAssetOnDemand } = await import('../services/cloud/updateService');
        if (isUpdateServiceInitialized()) {
          await prepareRuntimeAssetOnDemand('playwright-browser-runtime');
          loaded = requireOptionalNodeModule<unknown>('playwright', options);
        }
      }
    } catch (error) {
      return {
        ok: false,
        error: `Browser automation components could not be installed: ${error instanceof Error ? error.message : String(error)}`,
        missingPackage: true,
      };
    }
  }
  if (!loaded.ok) {
    return {
      ok: false,
      error: loaded.missingPackage
        ? 'Playwright package is unavailable in this runtime; prepare local browser automation components or use system Chrome after the package is present.'
        : loaded.error,
      missingPackage: loaded.missingPackage,
    };
  }

  if (!isPlaywrightModule(loaded.module)) {
    return {
      ok: false,
      error: `Playwright package loaded from ${loaded.path ?? 'unknown'} has no chromium export.`,
      missingPackage: false,
    };
  }

  return { ok: true, module: loaded.module };
}

export async function loadPlaywrightChromium(
  options: PlaywrightLoadOptions = {},
): Promise<PlaywrightChromiumLoadResult> {
  const playwright = await loadPlaywright(options);
  if (!playwright.ok || !playwright.module) {
    return {
      ok: false,
      error: playwright.error,
      missingPackage: playwright.missingPackage,
    };
  }
  return { ok: true, chromium: playwright.module.chromium };
}
