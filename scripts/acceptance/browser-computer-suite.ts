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
  --include-background-ax  Include the macOS background Accessibility action smoke.
  --help      Show this help.

What it validates:
  - Phase 2 smoke: managed browser + read-only Computer Surface
  - Phase 3 workflow smoke: isolated browser click + trace readback
  - Background AX smoke: optional native macOS target app + axPath type/click readback
  - Phase 4 UI smoke: real Chrome DOM rendering + input redaction
  - App-host smoke: real webServer + renderer AbilityMenu state/repair flow`);
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runPhase(phase: Phase, visible: boolean, skipBuild: boolean): Promise<number> {
  const args = [...phase.args];
  const forwardedArgs: string[] = [];
  if (visible && phase.forwardsVisible) {
    forwardedArgs.push('--visible');
  }
  if (skipBuild && phase.forwardsSkipBuild) {
    forwardedArgs.push('--skip-build');
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
  const includeBackgroundAx = hasFlag(args, 'include-background-ax')
    || process.env.CODE_AGENT_ACCEPTANCE_BACKGROUND_AX === '1';
  const startedAt = Date.now();
  const phases: Phase[] = [
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
    ...(includeBackgroundAx ? [{
      name: 'Background AX action smoke',
      command: npmCommand(),
      args: ['run', 'acceptance:browser-computer-background-ax'],
    }] satisfies Phase[] : []),
    {
      name: 'Phase 4 UI smoke',
      command: npmCommand(),
      args: ['run', 'acceptance:browser-computer-ui'],
    },
    {
      name: 'App-host AbilityMenu smoke',
      command: npmCommand(),
      args: ['run', 'acceptance:browser-computer-app-host'],
      forwardsVisible: true,
      forwardsSkipBuild: true,
    },
  ];

  const passed: string[] = [];

  for (const phase of phases) {
    console.log(`\n=== ${phase.name} ===`);
    const code = await runPhase(phase, visible, skipBuild);
    if (code !== 0) {
      throw new Error(`${phase.name} failed with exit code ${code}`);
    }
    passed.push(phase.name);
  }

  printKeyValue('Browser / Computer Acceptance Suite Summary', [
    ['passedPhases', passed.length],
    ['visibleMode', visible],
    ['skipBuild', skipBuild],
    ['backgroundAxIncluded', includeBackgroundAx],
    ['durationMs', Date.now() - startedAt],
  ]);
}

main().catch(finishWithError);
