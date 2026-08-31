import { AxeBuilder } from '@axe-core/playwright';
import {
  expect,
  test as base,
  type APIRequestContext,
  type Page,
  type Route,
  type TestInfo,
} from '@playwright/test';
import path from 'node:path';
import {
  AXE_ATTACHMENT_NAME,
  AXE_WCAG_TAGS,
  type AxeRoot,
  type AxeScanRecord,
} from './axeReport';

export { expect };
export type { APIRequestContext, Page, Route };

interface ScanA11yOptions {
  root?: AxeRoot;
  scanName?: string;
}

export async function scanA11y(
  page: Page,
  testInfo: TestInfo,
  options: ScanA11yOptions = {},
): Promise<AxeScanRecord> {
  if (page.isClosed()) {
    throw new Error(`[axe] 无法扫描已关闭页面：${testInfo.titlePath.join(' > ')}`);
  }

  const builder = new AxeBuilder({ page }).withTags([...AXE_WCAG_TAGS]);
  if (options.root) builder.include(options.root);
  const results = await builder.analyze();
  const record: AxeScanRecord = {
    schemaVersion: 1,
    scanName: options.scanName ?? 'manual',
    root: options.root ?? 'document',
    url: page.url(),
    scannedAt: new Date().toISOString(),
    testId: testInfo.testId,
    spec: path.relative(process.cwd(), testInfo.file).split(path.sep).join('/'),
    titlePath: testInfo.titlePath,
    projectName: testInfo.project.name,
    retry: testInfo.retry,
    violations: results.violations,
  };

  await testInfo.attach(AXE_ATTACHMENT_NAME, {
    body: Buffer.from(JSON.stringify(record)),
    contentType: 'application/json',
  });
  return record;
}

type AxeFixtures = {
  axeAutoScan: void;
};

export const test = base.extend<AxeFixtures>({
  axeAutoScan: [async ({ page }, use, testInfo) => {
    await use();
    const alreadyScanned = testInfo.attachments.some(({ name }) => name === AXE_ATTACHMENT_NAME);
    if (!alreadyScanned) await scanA11y(page, testInfo, { scanName: 'automatic' });
  }, { auto: true }],
});
