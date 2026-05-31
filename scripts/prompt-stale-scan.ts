#!/usr/bin/env npx tsx

import fs from 'fs';
import path from 'path';

type ScanTarget = {
  path: string;
  tokens: string[];
};

const TARGETS: ScanTarget[] = [
  {
    path: 'src/main/prompts',
    tokens: [
      'old_string',
      'new_string',
      'ToolSearch("',
      '<think>',
      '</think>',
      'CodeExecute',
      'execute_command',
      'read_file',
      'edit_file',
      'write_file',
      'web_search',
      'web_fetch',
      'read_xlsx',
      'enter_plan_mode',
      'exit_plan_mode',
      'ask_user_question',
      'task_create',
      'task_update',
    ],
  },
  {
    path: 'src/main/agent/runtime/contextAssembly/messageBuild.ts',
    tokens: [
      'ToolSearch("',
      '<think>',
      '</think>',
      'old_string',
      'new_string',
      'read_file',
      'edit_file',
      'write_file',
    ],
  },
  {
    path: 'src/main/agent/hybrid/coreAgents.ts',
    tokens: [
      'execute_command',
      'read_file',
      'edit_file',
      'write_file',
      'task_update',
      'task_create',
      '<think>',
      '</think>',
    ],
  },
  {
    path: 'src/main/agent/multiagentTools/spawnAgent.ts',
    tokens: [
      'execute_command',
      'read_file',
      'edit_file',
      'write_file',
      'task_update',
      'task_create',
      '<think>',
      '</think>',
    ],
  },
  {
    path: 'src/main/agent/nudgeManager.ts',
    tokens: [
      'ToolSearch("',
      '<think>',
      '</think>',
      'edit_file 或 write_file',
      'use task_update with status',
    ],
  },
];

const EXTENSIONS = new Set(['.ts', '.tsx', '.md', '.txt']);

function walk(targetPath: string): string[] {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return EXTENSIONS.has(path.extname(targetPath)) ? [targetPath] : [];
  }

  const out: string[] = [];
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const child = path.join(targetPath, entry.name);
    if (entry.isDirectory()) out.push(...walk(child));
    if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) out.push(child);
  }
  return out;
}

function lineFor(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

const repoRoot = process.cwd();
const findings: string[] = [];

for (const target of TARGETS) {
  const absoluteTarget = path.join(repoRoot, target.path);
  if (!fs.existsSync(absoluteTarget)) {
    findings.push(`${target.path}: target missing`);
    continue;
  }

  for (const filePath of walk(absoluteTarget)) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const token of target.tokens) {
      let index = content.indexOf(token);
      while (index !== -1) {
        const relative = path.relative(repoRoot, filePath);
        findings.push(`${relative}:${lineFor(content, index)} contains ${JSON.stringify(token)}`);
        index = content.indexOf(token, index + token.length);
      }
    }
  }
}

if (findings.length > 0) {
  console.error('Prompt stale token scan failed:');
  for (const finding of findings) {
    console.error(`  - ${finding}`);
  }
  process.exit(1);
}

console.log(`Prompt stale token scan passed (${TARGETS.length} target groups).`);
