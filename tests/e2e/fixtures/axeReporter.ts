import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  AXE_ATTACHMENT_NAME,
  AXE_REPORT_PATH,
  buildAxeRuntimeReport,
  type AxeScanRecord,
} from './axeReport';

function readAttachment(attachment: TestResult['attachments'][number]): string {
  if (attachment.body) return attachment.body.toString('utf8');
  if (attachment.path) return readFileSync(attachment.path, 'utf8');
  throw new Error('axe attachment 同时缺少 body 和 path');
}

function summaryMarkdown(report: ReturnType<typeof buildAxeRuntimeReport>): string {
  const rows = Object.entries(report.ruleCounts)
    .map(([rule, count]) => `| \`${rule}\` | ${count} |`);
  return [
    '### Runtime accessibility (axe-core)',
    '',
    `Scans: ${report.totals.scans}; rules with violations: ${report.totals.rules}; violating nodes: ${report.totals.hits}.`,
    '',
    '| Rule | Violating nodes |',
    '| --- | ---: |',
    ...(rows.length > 0 ? rows : ['| none | 0 |']),
    '',
    'WCAG violations are reported here; the ratchet blocks new rule types and reports existing-rule count drift.',
  ].join('\n');
}

export default class AxeReporter implements Reporter {
  private readonly scans = new Map<string, AxeScanRecord>();
  private reporterError?: Error;

  onTestEnd(test: TestCase, result: TestResult): void {
    for (const key of this.scans.keys()) {
      if (key.startsWith(`${test.id}\0`)) this.scans.delete(key);
    }

    try {
      const attachments = result.attachments.filter(({ name }) => name === AXE_ATTACHMENT_NAME);
      for (const attachment of attachments) {
        const scan = JSON.parse(readAttachment(attachment)) as AxeScanRecord;
        if (scan.schemaVersion !== 1 || scan.testId !== test.id || !Array.isArray(scan.violations)) {
          throw new Error(`axe attachment 结构无效：${test.titlePath().join(' > ')}`);
        }
        this.scans.set(`${test.id}\0${scan.scanName}`, scan);
      }
    } catch (error) {
      this.reporterError = error instanceof Error ? error : new Error(String(error));
    }
  }

  async onEnd(_result: FullResult): Promise<{ status: FullResult['status'] } | void> {
    try {
      if (this.reporterError) throw this.reporterError;
      const report = buildAxeRuntimeReport([...this.scans.values()]);
      const reportPath = path.resolve(AXE_REPORT_PATH);
      mkdirSync(path.dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      const markdown = summaryMarkdown(report);
      process.stdout.write(`\n${markdown}\n`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[axe-reporter] ✗ ${message}`);
      return { status: 'failed' };
    }
  }

  printsToStdio(): boolean {
    return false;
  }
}
