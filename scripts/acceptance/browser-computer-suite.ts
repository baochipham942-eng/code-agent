import { spawn } from 'child_process';
import {
  finishWithError,
  hasFlag,
  parseArgs,
  printKeyValue,
} from './_helpers.ts';

interface Phase {
  name: string;
  command: string;
  args: string[];
  forwardsVisible?: boolean;
  forwardsSkipBuild?: boolean;
}

function usage(): void {
  console.log(`Browser / Computer acceptance suite

Usage:
  npm run acceptance:browser-computer-all -- [options]

Options:
  --visible   Run managed-browser smokes in visible mode.
  --skip-build  Reuse existing app-host build artifacts.
  --provider <id> Browser provider for managed-browser smokes. Default: system-chrome-cdp.
  --include-background-ax  Include the macOS background Accessibility action smoke on non-macOS runs.
  --skip-background-ax  Skip the macOS default background Accessibility action smoke.
  --include-background-cgevent  Include the macOS background CGEvent action smoke on non-macOS runs.
  --skip-background-cgevent  Skip the macOS default background CGEvent action smoke.
  --help      Show this help.

What it validates:
  - System Chrome CDP smoke: system Chrome headless + isolated page over CDP
  - Phase 2 smoke: managed browser + read-only Computer Surface
  - Phase 3 workflow smoke: isolated browser click + trace readback
  - Phase 6 browser task benchmark: navigation, form, extract, login-like, download/upload, recovery, redaction, recipe rerun
  - Background AX smoke: native macOS target app + axPath type/click readback
  - Background CGEvent smoke: native macOS target app + pid/windowId/window-local click readback
  - Phase 4 UI smoke: real Chrome DOM rendering + input redaction
  - App-host smoke: real webServer + renderer Browser/Computer recovery flow`);
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function getProvider(args: ReturnType<typeof parseArgs>): string {
  const value = args.options.provider;
  if (value === undefined || value === true) {
    return 'system-chrome-cdp';
  }
  return Array.isArray(value) ? value[value.length - 1] : value;
}

function runPhase(phase: Phase, visible: boolean, skipBuild: boolean, provider: string): Promise<number> {
  const args = [...phase.args];
  const forwardedArgs: string[] = [];
  if (visible && phase.forwardsVisible) {
    forwardedArgs.push('--visible');
  }
  if (skipBuild && phase.forwardsSkipBuild) {
    forwardedArgs.push('--skip-build');
  }
  if (phase.name !== 'Background AX action smoke') {
    if (phase.name === 'Background CGEvent action smoke') {
      // no browser provider needed
    } else {
      forwardedArgs.push('--provider', provider);
    }
  }
  if (phase.name === 'Background AX action smoke') {
    // no browser provider needed
  }
  if (forwardedArgs.length > 0) {
    args.push('--', ...forwardedArgs);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(phase.command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }

  const visible = hasFlag(args, 'visible');
  const skipBuild = hasFlag(args, 'skip-build');
  const provider = getProvider(args);
  const includeBackgroundAx = hasFlag(args, 'include-background-ax')
    || process.env.CODE_AGENT_ACCEPTANCE_BACKGROUND_AX === '1'
    || (process.platform === 'darwin' && !hasFlag(args, 'skip-background-ax'));
  const includeBackgroundCgEvent = hasFlag(args, 'include-background-cgevent')
    || process.env.CODE_AGENT_ACCEPTANCE_BACKGROUND_CGEVENT === '1'
    || (process.platform === 'darwin' && !hasFlag(args, 'skip-background-cgevent'));
  const startedAt = Date.now();
  const phases: Phase[] = [
    {
      name: 'System Chrome CDP smoke',
      command: 'npx',
      args: ['tsx', 'scripts/acceptance/browser-computer-system-chrome-smoke.ts'],
      forwardsVisible: true,
    },
    {
      name: 'Phase 2 smoke',
      command: npmCommand(),
      args: ['run', 'acceptance:browser-computer'],
      forwardsVisible: true,
    },
    {
      name: 'Phase 3 workflow smoke',
      command: npmCommand(),
      args: ['run', 'acceptance:browser-computer-workflow'],
      forwardsVisible: true,
    },
    {
      name: 'Phase 6 browser task benchmark',
      command: npmCommand(),
      args: ['run', 'acceptance:browser-task-benchmark'],
      forwardsVisible: true,
    },
    ...(includeBackgroundAx ? [{
      name: 'Background AX action smoke',
      command: npmCommand(),
      args: ['run', 'acceptance:browser-computer-background-ax'],
    }] satisfies Phase[] : []),
    ...(includeBackgroundCgEvent ? [{
      name: 'Background CGEvent action smoke',
      command: npmCommand(),
      args: ['run', 'acceptance:browser-computer-background-cgevent'],
    }] satisfies Phase[] : []),
    {
      name: 'Phase 4 UI smoke',
      command: npmCommand(),
      args: ['run', 'acceptance:browser-computer-ui'],
    },
    {
      name: 'App-host Browser/Computer smoke',
      command: npmCommand(),
      args: ['run', 'acceptance:browser-computer-app-host'],
      forwardsVisible: true,
      forwardsSkipBuild: true,
    },
  ];

  const passed: string[] = [];

  for (const phase of phases) {
    console.log(`\n=== ${phase.name} ===`);
    const code = await runPhase(phase, visible, skipBuild, provider);
    if (code !== 0) {
      throw new Error(`${phase.name} failed with exit code ${code}`);
    }
    passed.push(phase.name);
  }

  printKeyValue('Browser / Computer Acceptance Suite Summary', [
    ['passedPhases', passed.length],
    ['visibleMode', visible],
    ['browserProvider', provider],
    ['skipBuild', skipBuild],
    ['backgroundAxIncluded', includeBackgroundAx],
    ['backgroundCgEventIncluded', includeBackgroundCgEvent],
    ['durationMs', Date.now() - startedAt],
  ]);
}

main().catch(finishWithError);
