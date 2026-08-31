#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  appendRubricToPrompt,
  asStringList,
  parseRepeatedArgs,
  readRubric,
  validateReviewDraft,
} from './visual-review-core.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`VLM visual review draft (Codex subscription seat)

Usage:
  node scripts/visual-review/review-images-with-codex.mjs \\
    --mode single --image shot.png --out review.json

  node scripts/visual-review/review-images-with-codex.mjs \\
    --mode triptych --image before.png --image after.png --image diff.png \\
    --out review.json

Options:
  --mode <single|triptych>  Required.
  --image <path>            Repeat once (single) or three times (triptych).
  --out <path>              Structured candidate draft JSON. Required.
  --raw-out <path>          Codex JSONL transcript. Default: <out>.raw.jsonl.
  --rubric <path>           Default: scripts/visual-review/rubric.json.
  --prompt <path>           Default: scripts/visual-review/vlm-review-prompt.md.
  --schema <path>           Default: scripts/visual-review/vlm-review-output.schema.json.
  --model <name>            Optional Codex model override.
  --binary <path>           Default: codex.
  --timeout-ms <number>     Default: 180000; timeout is a hard failure, never a pass.
  --help                    Show help.

This command creates a draft only. It does not run in CI and never blocks a PR.`);
}

function runCodex(binary, args, prompt, rawOut, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timeoutHandle);
      reject(error);
    });
    child.once('close', async (code) => {
      clearTimeout(timeoutHandle);
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      await fs.writeFile(rawOut, stdoutText, 'utf8');
      if (timedOut) {
        reject(new Error(`codex exec timed out after ${timeoutMs}ms; raw transcript: ${rawOut}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`codex exec failed (${code}): ${stderrText || stdoutText}`));
        return;
      }
      resolve({ stdout: stdoutText, stderr: stderrText });
    });
    child.stdin.end(prompt);
  });
}

async function main() {
  const args = parseRepeatedArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const mode = String(args.mode ?? '');
  if (mode !== 'single' && mode !== 'triptych') {
    throw new Error('--mode must be single or triptych');
  }
  const images = asStringList(args.image).map((file) => path.resolve(file));
  const expectedCount = mode === 'single' ? 1 : 3;
  if (images.length !== expectedCount) {
    throw new Error(`${mode} mode requires exactly ${expectedCount} --image argument(s)`);
  }
  if (!args.out || typeof args.out !== 'string') throw new Error('--out is required');

  const out = path.resolve(args.out);
  const rawOut = path.resolve(
    typeof args['raw-out'] === 'string' ? args['raw-out'] : `${out}.raw.jsonl`,
  );
  const rubricPath = path.resolve(
    typeof args.rubric === 'string' ? args.rubric : path.join(scriptDir, 'rubric.json'),
  );
  const promptPath = path.resolve(
    typeof args.prompt === 'string' ? args.prompt : path.join(scriptDir, 'vlm-review-prompt.md'),
  );
  const schemaPath = path.resolve(
    typeof args.schema === 'string'
      ? args.schema
      : path.join(scriptDir, 'vlm-review-output.schema.json'),
  );
  const timeoutMs = args['timeout-ms'] === undefined
    ? 180_000
    : Number(args['timeout-ms']);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }

  await Promise.all(images.map((image) => fs.access(image)));
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.mkdir(path.dirname(rawOut), { recursive: true });

  const [rubric, promptTemplate] = await Promise.all([
    readRubric(rubricPath),
    fs.readFile(promptPath, 'utf8'),
  ]);
  const prompt = appendRubricToPrompt(promptTemplate, rubric, mode);
  const lastMessagePath = `${out}.codex-last.json`;
  const codexArgs = [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--output-schema',
    schemaPath,
    '--output-last-message',
    lastMessagePath,
    ...(typeof args.model === 'string' ? ['--model', args.model] : []),
    ...images.flatMap((image) => ['--image', image]),
    '-',
  ];

  await runCodex(
    typeof args.binary === 'string' ? args.binary : 'codex',
    codexArgs,
    prompt,
    rawOut,
    timeoutMs,
  );
  const draft = validateReviewDraft(
    JSON.parse(await fs.readFile(lastMessagePath, 'utf8')),
    rubric,
    mode,
  );
  await fs.writeFile(out, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  await fs.rm(lastMessagePath, { force: true });
  console.log(`VLM candidate draft: ${out}`);
  console.log(`Raw Codex transcript: ${rawOut}`);
  console.log('Draft only: human review is required for RED items; this command does not gate CI/PR.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
