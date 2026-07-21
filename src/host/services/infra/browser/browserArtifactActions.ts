import * as fs from 'fs';
import * as path from 'path';
import {
  createBrowserArtifactSummary,
  inferMimeType,
  sanitizeArtifactFilename,
} from './managedBrowserHelpers';
import {
  readVerifiedBrowserUploadFile,
  type ApprovedBrowserUploadFile,
} from './browserUploadApprovalRegistry';
export type { ApprovedBrowserUploadFile } from './browserUploadApprovalRegistry';
import type {
  BrowserArtifactSummary,
  BrowserTab,
  BrowserTargetRef,
  ScreenshotResult,
} from './types';

export async function captureBrowserScreenshot(args: {
  tab: BrowserTab;
  screenshotDir: string;
  options?: {
    fullPage?: boolean;
    selector?: string;
    format?: 'png' | 'jpeg';
  };
}): Promise<ScreenshotResult> {
  const { tab, screenshotDir } = args;
  const options = args.options || {};
  const filename = `screenshot_${Date.now()}.${options.format || 'png'}`;
  const filepath = path.join(screenshotDir, filename);

  try {
    if (options.selector) {
      const element = await tab.page.$(options.selector);
      if (!element) {
        return { success: false, error: `Element not found: ${options.selector}` };
      }
      await element.screenshot({ path: filepath });
    } else {
      await tab.page.screenshot({
        path: filepath,
        fullPage: options.fullPage || false,
      });
    }

    const base64 = fs.readFileSync(filepath).toString('base64');
    return {
      success: true,
      path: filepath,
      base64,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Screenshot failed',
    };
  }
}

export async function waitForBrowserDownload(args: {
  tab: BrowserTab;
  trigger: { selector?: string; targetRef?: unknown };
  clickTargetRef: (targetRef: unknown) => Promise<BrowserTargetRef>;
  downloadDir: string;
  sessionId: string | null;
}): Promise<BrowserArtifactSummary> {
  const downloadPromise = args.tab.page.waitForEvent('download', { timeout: 15_000 });
  if (args.trigger.targetRef) {
    await args.clickTargetRef(args.trigger.targetRef);
  } else if (args.trigger.selector) {
    await args.tab.page.click(args.trigger.selector);
  } else {
    throw new Error('selector or targetRef required for wait_for_download');
  }

  const download = await downloadPromise;
  const suggestedName = sanitizeArtifactFilename(download.suggestedFilename() || `download_${Date.now()}`);
  fs.mkdirSync(args.downloadDir, { recursive: true });
  const artifactPath = path.join(args.downloadDir, suggestedName);
  await download.saveAs(artifactPath);
  return createBrowserArtifactSummary({
    kind: 'download',
    artifactPath,
    mimeType: inferMimeType(suggestedName),
    sessionId: args.sessionId,
  });
}

export async function uploadBrowserFile(args: {
  approvedFile: ApprovedBrowserUploadFile;
  selector?: string;
  targetRef?: unknown;
  tabId?: string;
  sessionId: string | null;
  getTab: (tabId?: string) => BrowserTab;
  resolveTargetRef: (targetRef: unknown, tabId?: string) => Promise<{ targetRef: BrowserTargetRef }>;
}): Promise<BrowserArtifactSummary> {
  if (args.targetRef) {
    const resolved = await args.resolveTargetRef(args.targetRef, args.tabId);
    const tab = args.getTab(resolved.targetRef.tabId);
    await setUploadFileOnTarget(tab, resolved.targetRef.selector, args.approvedFile);
  } else {
    if (!args.selector) {
      throw new Error('selector or targetRef required for upload_file');
    }
    const tab = args.getTab(args.tabId);
    await setUploadFileOnTarget(tab, args.selector, args.approvedFile);
  }

  const createdAtMs = Date.now();
  return {
    artifactId: `upload_${createdAtMs}_${args.approvedFile.sha256.slice(0, 12)}`,
    kind: 'upload',
    name: args.approvedFile.name,
    artifactPath: args.approvedFile.normalizedPath,
    size: args.approvedFile.size,
    mimeType: inferMimeType(args.approvedFile.name),
    sha256: args.approvedFile.sha256,
    createdAtMs,
    sessionId: args.sessionId,
  };
}

async function setUploadFileOnTarget(
  tab: BrowserTab,
  selector: string,
  approvedFile: ApprovedBrowserUploadFile,
): Promise<void> {
  const locator = tab.page.locator(selector).first();
  const isFileInput = await locator.evaluate((element) => {
    return element.tagName.toLowerCase() === 'input'
      && (element.getAttribute('type') || '').toLowerCase() === 'file';
  }).catch(() => false);
  if (isFileInput) {
    const verified = readVerifiedBrowserUploadFile(approvedFile);
    await locator.setInputFiles({
      name: verified.file.name,
      mimeType: inferMimeType(verified.file.name) || 'application/octet-stream',
      buffer: verified.buffer,
    });
    return;
  }

  const fileChooserPromise = tab.page.waitForEvent('filechooser', { timeout: 10_000 });
  await locator.click();
  const fileChooser = await fileChooserPromise;
  const verified = readVerifiedBrowserUploadFile(approvedFile);
  await fileChooser.setFiles({
    name: verified.file.name,
    mimeType: inferMimeType(verified.file.name) || 'application/octet-stream',
    buffer: verified.buffer,
  });
}
