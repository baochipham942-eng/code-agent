import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ViteDevServer } from 'vite';
import type { Browser } from 'playwright';
import { JOURNEY_IDS, isJourneyId, type JourneyId, type JourneyProbeResult } from './journey-probe-protocol';
import { launchJourneyBrowser, measureJourney, startJourneyViteServer } from './journey-probe-runtime';

export interface JourneyBrowserSmokeOptions {
  journeys: JourneyId[];
  extraRenders: number;
  repeats: number;
  outputPath: string | null;
  help: boolean;
}

export function parseJourneyBrowserSmokeOptions(argv: string[]): JourneyBrowserSmokeOptions {
  let journeys: JourneyId[] | null = null;
  let extraRenders = 0;
  let repeats = 1;
  let outputPath: string | null = null;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      help = true;
      continue;
    }
    if (argument === '--journey') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--journey requires cold-start|first-token|long-session|session-switch|all');
      if (value === 'all') journeys = [...JOURNEY_IDS];
      else if (isJourneyId(value)) journeys = [value];
      else throw new Error(`Unknown journey: ${value}`);
      index += 1;
      continue;
    }
    if (argument === '--extra-renders') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--extra-renders requires an integer');
      extraRenders = Number(value);
      if (!Number.isInteger(extraRenders) || extraRenders < 0) {
        throw new Error('--extra-renders must be a non-negative integer');
      }
      index += 1;
      continue;
    }
    if (argument === '--repeat') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--repeat requires an integer');
      repeats = Number(value);
      if (!Number.isInteger(repeats) || repeats < 1) {
        throw new Error('--repeat must be a positive integer');
      }
      index += 1;
      continue;
    }
    if (argument === '--out') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--out requires a file path');
      outputPath = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    journeys: journeys ?? [...JOURNEY_IDS],
    extraRenders,
    repeats,
    outputPath,
    help,
  };
}

function usage(): void {
  process.stdout.write(`Perf journey browser probes

Usage:
  npx tsx scripts/perf/journey-browser-smoke.ts [options]

Options:
  --journey <id|all>     cold-start | first-token | long-session | session-switch | all
  --extra-renders <n>    Inject n extra Profiler commits (correlation / mutation)
  --repeat <n>           Run each journey n times on the same Vite/browser
  --out <path>           Write JSON report (single journey: one object; all: array)
  --help
`);
}

export async function runJourneyBrowserSmoke(
  options: JourneyBrowserSmokeOptions,
): Promise<JourneyProbeResult[]> {
  let server: ViteDevServer | null = null;
  let browser: Browser | null = null;
  try {
    server = await startJourneyViteServer();
    browser = await launchJourneyBrowser();
    const results: JourneyProbeResult[] = [];
    for (let round = 0; round < options.repeats; round += 1) {
      for (const journey of options.journeys) {
        results.push(await measureJourney({
          journey,
          extraRenders: options.extraRenders,
          server,
          browser,
        }));
      }
    }
    return results;
  } finally {
    await browser?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const options = parseJourneyBrowserSmokeOptions(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const results = await runJourneyBrowserSmoke(options);
  const payload = results.length === 1 ? results[0] : results;
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (options.outputPath) {
    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
    fs.writeFileSync(options.outputPath, text);
  }
  process.stdout.write(text);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
