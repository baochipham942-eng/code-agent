// ============================================================================
// Doctor CLI — `neo doctor` and `neo doctor sandbox`
// ============================================================================
//
// Lightweight route (see src/cli/index.ts): does not load chat/run/serve.
// `sandbox` only probes seatbelt/bwrap. Bare `doctor` runs the full report.

import { Command } from 'commander';
import { formatOsSandboxProbe, probeOsSandbox } from '../../host/sandbox/probe';

interface DoctorJsonOptions {
  json?: boolean;
}

async function runFullDoctor(options: DoctorJsonOptions): Promise<void> {
  const { runDoctor } = await import('../../host/diagnostics/doctorRunner');
  const report = await runDoctor();
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const item of report.items) {
      const glyph = item.status === 'pass' ? '✓' : item.status === 'warn' ? '⚠' : item.status === 'fail' ? '✗' : '-';
      process.stdout.write(`  ${glyph} ${item.name}: ${item.message}\n`);
    }
    const { pass, warn, fail, skip } = report.summary;
    process.stdout.write(`\nSummary: ${pass} pass / ${warn} warn / ${fail} fail / ${skip} skip\n`);
  }
  if (report.summary.fail > 0) process.exitCode = 1;
}

function runSandboxProbe(options: DoctorJsonOptions): void {
  const probe = probeOsSandbox();
  if (options.json) {
    process.stdout.write(`${JSON.stringify(probe, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatOsSandboxProbe(probe)}\n`);
  }
  if (!probe.available) process.exitCode = 1;
}

export const doctorCliCommand = new Command('doctor')
  .description('Run health checks, or probe OS sandbox availability')
  .option('--json', 'JSON output')
  .action(async (options: DoctorJsonOptions) => {
    await runFullDoctor(options);
  });

doctorCliCommand
  .command('sandbox')
  .description('Probe seatbelt/bwrap availability and print the sandbox profile summary')
  .option('--json', 'JSON output')
  .action((options: DoctorJsonOptions) => {
    runSandboxProbe(options);
  });
