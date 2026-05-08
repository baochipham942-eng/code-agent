type PlaywrightModule = typeof import('playwright');

export interface PlaywrightChromiumLoadResult {
  ok: boolean;
  chromium?: PlaywrightModule['chromium'];
  error?: string;
  missingPackage?: boolean;
}

export async function loadPlaywrightChromium(): Promise<PlaywrightChromiumLoadResult> {
  try {
    const playwright = await import('playwright');
    return { ok: true, chromium: playwright.chromium };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingPackage =
      /Cannot find package 'playwright'|Cannot find module 'playwright'|ERR_MODULE_NOT_FOUND/i.test(message);
    return {
      ok: false,
      error: missingPackage
        ? 'Playwright package is unavailable in this runtime; bundle node_modules/playwright and node_modules/playwright-core, or use system Chrome after the package is present.'
        : message,
      missingPackage,
    };
  }
}
