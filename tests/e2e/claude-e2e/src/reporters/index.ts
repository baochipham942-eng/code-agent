import { TestReport } from '../types.js';
import { ConsoleReporter } from './console.js';
import { JsonReporter } from './json.js';
import { HtmlReporter } from './html.js';

export type ReportFormat = 'console' | 'json' | 'html' | 'all';

export interface ReportOptions {
  formats: ReportFormat[];
  outputDir?: string;
  verbose?: boolean;
}

export async function generateReports(
  report: TestReport,
  options: ReportOptions
): Promise<void> {
  const { formats, outputDir = './results', verbose = false } = options;

  const reporters: Record<string, { generate: (r: TestReport) => Promise<string | void> }> = {
    console: new ConsoleReporter({ outputDir, verbose }),
    json: new JsonReporter({ outputDir, verbose }),
    html: new HtmlReporter({ outputDir, verbose }),
  };

  // 处理 "html,json" 等逗号分隔的格式
  const parsedFormats = formats.flatMap((f) => f.split(',').map((s) => s.trim()));

  const activeFormats = parsedFormats.includes('all')
    ? ['console', 'json', 'html']
    : parsedFormats.filter((f) => f !== 'all' && f in reporters);

  for (const format of activeFormats) {
    await reporters[format].generate(report);
  }
}

export { ConsoleReporter, JsonReporter, HtmlReporter };
