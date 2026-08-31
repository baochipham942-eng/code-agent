import type { AxeBuilder } from '@axe-core/playwright';

export const AXE_ATTACHMENT_NAME = 'axe-runtime-scan';
export const AXE_REPORT_PATH = 'test-results/axe/axe-report.json';
export const AXE_PLAYWRIGHT_VERSION = '4.13.0';
export const AXE_WCAG_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22a',
  'wcag22aa',
] as const;

export type AxeRoot = Parameters<AxeBuilder['include']>[0];
type AxeViolation = Awaited<ReturnType<AxeBuilder['analyze']>>['violations'][number];

export interface AxeScanRecord {
  schemaVersion: 1;
  scanName: string;
  root: AxeRoot | 'document';
  url: string;
  scannedAt: string;
  testId: string;
  spec: string;
  titlePath: string[];
  projectName: string;
  retry: number;
  violations: AxeViolation[];
}

export interface AxeRuntimeReport {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    package: '@axe-core/playwright';
    version: string;
    runOnly: {
      type: 'tag';
      values: string[];
    };
  };
  totals: {
    scans: number;
    rules: number;
    hits: number;
  };
  ruleCounts: Record<string, number>;
  scans: AxeScanRecord[];
}

export function buildAxeRuntimeReport(scans: AxeScanRecord[]): AxeRuntimeReport {
  const sortedScans = [...scans].sort((left, right) => {
    const testOrder = `${left.spec}\0${left.titlePath.join('\0')}\0${left.scanName}`
      .localeCompare(`${right.spec}\0${right.titlePath.join('\0')}\0${right.scanName}`);
    return testOrder || left.retry - right.retry;
  });
  const ruleCounts: Record<string, number> = {};

  for (const scan of sortedScans) {
    for (const violation of scan.violations) {
      ruleCounts[violation.id] = (ruleCounts[violation.id] ?? 0) + violation.nodes.length;
    }
  }

  const orderedRuleCounts = Object.fromEntries(
    Object.entries(ruleCounts).sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      package: '@axe-core/playwright',
      version: AXE_PLAYWRIGHT_VERSION,
      runOnly: { type: 'tag', values: [...AXE_WCAG_TAGS] },
    },
    totals: {
      scans: sortedScans.length,
      rules: Object.keys(orderedRuleCounts).length,
      hits: Object.values(orderedRuleCounts).reduce((sum, count) => sum + count, 0),
    },
    ruleCounts: orderedRuleCounts,
    scans: sortedScans,
  };
}
