#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  createPixelDiff,
  listPngFiles,
  parseRepeatedArgs,
} from './visual-review-core.mjs';

const defaultSpec = 'tests/e2e/visual-shotbase.spec.ts';
const defaultConfig = 'tests/e2e/playwright.e2e.config.ts';

function usage() {
  console.log(`Generate before / after / diff screenshots for a renderer change

Usage:
  node scripts/visual-review/generate-triptych.mjs \\
    --base <git-ref> --head <git-ref> --out-dir <directory>

Options:
  --base <ref>               Required base revision.
  --head <ref>               Required head revision.
  --out-dir <directory>      Required fresh output directory.
  --spec <path>              Default: ${defaultSpec}.
  --config <path>            Default: ${defaultConfig}.
  --node-modules-dir <path>  Optional complete dependency install for shared-worktree probes.
  --allow-non-linux-probe    Allow a local probe; manifest is marked formal=false.
  --help                     Show help.

Formal artifacts are accepted only on Linux/Chromium. The command checks out both
revisions into temporary detached worktrees and never edits the caller worktree.`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    const stdout = [];
    const stderr = [];
    if (options.capture) {
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
    }
    child.once('error', reject);
    child.once('close', (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code !== 0 && !options.allowFailure) {
        reject(new Error(
          `${command} ${args.join(' ')} failed (${code})${result.stderr ? `\n${result.stderr}` : ''}`,
        ));
        return;
      }
      resolve(result);
    });
  });
}

async function resolveRepoRoot() {
  const result = await run('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    capture: true,
  });
  return result.stdout.trim();
}

async function resolveRef(repoRoot, ref) {
  const result = await run('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: repoRoot,
    capture: true,
  });
  return result.stdout.trim();
}

async function ensureFreshOutput(outDir) {
  try {
    const entries = await fs.readdir(outDir);
    if (entries.length > 0) {
      throw new Error(`--out-dir must be empty or absent: ${outDir}`);
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      await fs.mkdir(outDir, { recursive: true });
      return;
    }
    throw error;
  }
}

async function prepareWorktree(repoRoot, tempRoot, name, sha, nodeModulesDir) {
  const worktree = path.join(tempRoot, name);
  await run('git', ['worktree', 'add', '--detach', worktree, sha], { cwd: repoRoot });
  await fs.symlink(nodeModulesDir, path.join(worktree, 'node_modules'), 'dir');
  return worktree;
}

async function recordRevision({ worktree, spec, config, output, nonLinuxProbe }) {
  const logPath = path.join(output, 'playwright.log');
  const result = await run(
    path.join(worktree, 'node_modules', '.bin', 'playwright'),
    [
      'test',
      '--config',
      config,
      spec,
      '--workers=1',
      '--update-snapshots',
    ],
    {
      cwd: worktree,
      capture: true,
      env: {
        ...process.env,
        CI: '1',
        E2E_DISABLE_VIDEO: '1',
        ...(nonLinuxProbe ? { E2E_VISUAL_LOCAL_PROBE: '1' } : {}),
      },
      allowFailure: true,
    },
  );
  await fs.writeFile(logPath, `${result.stdout}${result.stderr}`, 'utf8');
  if (result.code !== 0) {
    const tail = `${result.stdout}${result.stderr}`.slice(-8_000);
    throw new Error(`Playwright visual record failed (${result.code}); log=${logPath}\n${tail}`);
  }

  const snapshotDirectory = path.join(worktree, `${spec}-snapshots`);
  const platformSuffix = `-chromium-${process.platform}.png`;
  const screenshots = (await listPngFiles(snapshotDirectory))
    .filter((screenshot) => screenshot.endsWith(platformSuffix));
  if (screenshots.length === 0) {
    throw new Error(`No screenshots generated under ${snapshotDirectory}`);
  }
  for (const screenshot of screenshots) {
    await fs.copyFile(screenshot, path.join(output, path.basename(screenshot)));
  }
  return screenshots.map((screenshot) => path.basename(screenshot));
}

async function generateDiffs(beforeDir, afterDir, diffDir, names) {
  const metrics = [];
  for (const name of names) {
    const [before, after] = await Promise.all([
      fs.readFile(path.join(beforeDir, name)),
      fs.readFile(path.join(afterDir, name)),
    ]);
    const result = createPixelDiff(before, after);
    const diffName = name.replace(/\.png$/, '-diff.png');
    await fs.writeFile(path.join(diffDir, diffName), result.buffer);
    metrics.push({
      screenshot: name,
      diff: diffName,
      width: result.width,
      height: result.height,
      changedPixels: result.changedPixels,
      maskedPixels: result.maskedPixels,
      scoredPixels: result.scoredPixels,
      changedRatio: result.changedRatio,
    });
  }
  return metrics;
}

async function removeTempWorktree(repoRoot, worktree) {
  if (!worktree) return;
  await run('git', ['worktree', 'remove', '--force', worktree], {
    cwd: repoRoot,
    capture: true,
  });
}

async function main() {
  const args = parseRepeatedArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (typeof args.base !== 'string' || typeof args.head !== 'string') {
    throw new Error('--base and --head are required');
  }
  if (typeof args['out-dir'] !== 'string') throw new Error('--out-dir is required');

  const formal = process.platform === 'linux';
  if (!formal && args['allow-non-linux-probe'] !== true) {
    throw new Error(
      `Formal visual artifacts require Linux/Chromium; current platform is ${process.platform}. `
      + 'Use --allow-non-linux-probe only for local tooling probes.',
    );
  }

  const repoRoot = await resolveRepoRoot();
  const outDir = path.resolve(args['out-dir']);
  const nodeModulesDir = path.resolve(
    typeof args['node-modules-dir'] === 'string'
      ? args['node-modules-dir']
      : path.join(repoRoot, 'node_modules'),
  );
  await fs.access(nodeModulesDir);
  const spec = typeof args.spec === 'string' ? args.spec : defaultSpec;
  const config = typeof args.config === 'string' ? args.config : defaultConfig;
  if (path.isAbsolute(spec) || path.isAbsolute(config)) {
    throw new Error('--spec and --config must be repository-relative paths');
  }
  await ensureFreshOutput(outDir);

  const [baseSha, headSha] = await Promise.all([
    resolveRef(repoRoot, args.base),
    resolveRef(repoRoot, args.head),
  ]);
  const beforeDir = path.join(outDir, 'before');
  const afterDir = path.join(outDir, 'after');
  const diffDir = path.join(outDir, 'diff');
  await Promise.all([
    fs.mkdir(beforeDir, { recursive: true }),
    fs.mkdir(afterDir, { recursive: true }),
    fs.mkdir(diffDir, { recursive: true }),
  ]);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-agent-vlm-triptych-'));
  let baseWorktree;
  let headWorktree;
  try {
    baseWorktree = await prepareWorktree(repoRoot, tempRoot, 'base', baseSha, nodeModulesDir);
    const beforeNames = await recordRevision({
      worktree: baseWorktree,
      spec,
      config,
      output: beforeDir,
      nonLinuxProbe: !formal,
    });
    await removeTempWorktree(repoRoot, baseWorktree);
    baseWorktree = undefined;

    headWorktree = await prepareWorktree(repoRoot, tempRoot, 'head', headSha, nodeModulesDir);
    const afterNames = await recordRevision({
      worktree: headWorktree,
      spec,
      config,
      nodeModulesDir,
      output: afterDir,
      nonLinuxProbe: !formal,
    });
    if (JSON.stringify(beforeNames) !== JSON.stringify(afterNames)) {
      throw new Error(
        `Base/head screenshot sets differ: before=${beforeNames.join(',')} after=${afterNames.join(',')}`,
      );
    }
    const metrics = await generateDiffs(beforeDir, afterDir, diffDir, beforeNames);
    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      draftInputOnly: true,
      formal,
      platform: process.platform,
      browser: 'chromium',
      base: { ref: args.base, sha: baseSha },
      head: { ref: args.head, sha: headSha },
      spec,
      config,
      snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-chromium-{platform}{ext}',
      maskPolicy: 'Union of Playwright #FF00FF mask pixels is excluded from changedPixels/scoredPixels.',
      screenshots: metrics,
    };
    await fs.writeFile(
      path.join(outDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    console.log(`Triptych artifacts: ${outDir}`);
    console.log(`Formal Linux/Chromium evidence: ${formal ? 'yes' : 'no (local probe only)'}`);
  } finally {
    await removeTempWorktree(repoRoot, baseWorktree);
    await removeTempWorktree(repoRoot, headWorktree);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
