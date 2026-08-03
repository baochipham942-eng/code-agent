#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CLOSURE_SCHEMA_VERSION,
  TASK_CLOSURE_KIND,
  buildTaskClosure,
  formatClosureEvidenceMarker,
  writeJsonReport,
} from './lib/closure-evidence.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function usage() {
  return `Usage: node scripts/task-closure.mjs --spec <task-spec.json> --out <task-report.json> [--json]

The spec binds every final diff path to focused checks and acceptance commands:
{
  "schemaVersion": 1,
  "taskId": "task-run-id",
  "evidenceProfile": "stable-profile-for-comparable-runs",
  "baseRef": "origin/main",
  "checks": [{"id":"focused","packageScript":"test:closure","reason":"focused contract regression"}],
  "acceptance": [{
    "id":"acceptance",
    "packageScript":"acceptance:closure",
    "reason":"CLI and contract acceptance",
    "readbacks":[{"path":"scripts/task-closure.mjs","nonEmpty":true,"contains":["buildTaskClosure"]}]
  }],
  "scopeMappings": [{
    "pathPrefixes":["scripts/", "tests/scripts/", "package.json", ".agents/skills/pr/SKILL.md"],
    "checkIds":["focused"],
    "acceptanceIds":["acceptance"]
  }]
}`;
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const read = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return { spec: read('--spec'), out: read('--out'), json: argv.includes('--json') };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!args.spec || !args.out) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  try {
    const spec = JSON.parse(fs.readFileSync(path.resolve(args.spec), 'utf8'));
    const report = await buildTaskClosure(spec, { repoRoot });
    const written = writeJsonReport(args.out, report);
    const marker = formatClosureEvidenceMarker(report, written.sha256);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.stderr.write(`${marker}\n`);
    } else {
      process.stdout.write(`[task-closure] ${report.status} report=${written.path} diff=${report.repository.diffSha256}\n${marker}\n`);
    }
    return report.status === 'VERIFIED' ? 0 : 1;
  } catch (error) {
    const report = {
      schemaVersion: CLOSURE_SCHEMA_VERSION,
      kind: TASK_CLOSURE_KIND,
      status: 'BLOCKED',
      failures: [{ code: 'invalid_task_closure', message: error instanceof Error ? error.message : String(error) }],
    };
    const written = writeJsonReport(args.out, report);
    process.stdout.write(`${formatClosureEvidenceMarker(report, written.sha256)}\n`);
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
