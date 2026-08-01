#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CLOSURE_SCHEMA_VERSION,
  DELIVERY_CLOSURE_KIND,
  buildDeliveryClosure,
  formatClosureEvidenceMarker,
  writeJsonReport,
} from './lib/closure-evidence.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function usage() {
  return `Usage: node scripts/delivery-closure.mjs --spec <delivery-spec.json> --out <delivery-report.json> [--json]

The delivery spec references task evidence and records fingerprint/recovery/approval boundaries:
{
  "schemaVersion": 1,
  "deliveryId": "delivery-run-id",
  "evidenceProfile": "stable-profile-for-comparable-runs",
  "taskClosureReport": "/tmp/task-closure.json",
  "deliverable": {"commitRef":"HEAD", "artifactPaths":[]},
  "approvalBoundary": {
    "currentScope":["local edits", "local verification"],
    "requiresApproval":["commit", "push", "merge"],
    "prohibitedActions":["manual merge", "force push"]
  },
  "recoveryActions": [],
  "handoff": {"summary":"handoff is context only"}
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

export function main(argv = process.argv.slice(2)) {
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
    const taskClosure = spec.taskClosureReport
      ? JSON.parse(fs.readFileSync(path.resolve(spec.taskClosureReport), 'utf8'))
      : undefined;
    const report = buildDeliveryClosure(spec, { repoRoot, taskClosure });
    const written = writeJsonReport(args.out, report);
    const marker = formatClosureEvidenceMarker(report, written.sha256);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.stderr.write(`${marker}\n`);
    } else {
      process.stdout.write(`[delivery-closure] ${report.status} report=${written.path}\n${marker}\n`);
    }
    return report.status === 'VERIFIED' ? 0 : 1;
  } catch (error) {
    const report = {
      schemaVersion: CLOSURE_SCHEMA_VERSION,
      kind: DELIVERY_CLOSURE_KIND,
      status: 'BLOCKED',
      failures: [{ code: 'invalid_delivery_closure', message: error instanceof Error ? error.message : String(error) }],
    };
    const written = writeJsonReport(args.out, report);
    process.stdout.write(`${formatClosureEvidenceMarker(report, written.sha256)}\n`);
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
