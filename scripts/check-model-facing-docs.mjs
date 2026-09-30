#!/usr/bin/env node
// Validate the model-facing surface document without third-party dependencies.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DOC_RELATIVE_PATH = 'docs/architecture/model-facing-surface.md';
const REQUIRED_HEADINGS = [
  'What the model sees',
  'Token impact',
  'KV-cache impact',
  'Known limits',
];
const KNOWN_EXTENSIONS = new Set([
  '.cjs', '.css', '.h', '.html', '.js', '.json', '.jsx', '.mjs', '.md', '.py',
  '.rs', '.sh', '.sql', '.ts', '.tsx', '.toml', '.yml', '.yaml',
]);

export function checkModelFacingDocs(content, repoRoot = DEFAULT_REPO_ROOT) {
  const withoutFences = content.replace(/```[\s\S]*?```/g, '');
  const lines = withoutFences.split(/\r?\n/);
  const entryStarts = [];
  const entryHeading = /^(## |#### )([^#].*)$/;

  for (let index = 0; index < lines.length; index += 1) {
    const match = entryHeading.exec(lines[index]);
    if (match) entryStarts.push({ index, title: match[2].trim() });
  }

  const errors = [];
  if (entryStarts.length < 3) {
    errors.push(`expected at least 3 entry blocks, found ${entryStarts.length}`);
  }

  for (let entryIndex = 0; entryIndex < entryStarts.length; entryIndex += 1) {
    const start = entryStarts[entryIndex].index;
    const end = entryStarts[entryIndex + 1]?.index ?? lines.length;
    const block = lines.slice(start, end);
    const headings = block
      .map((line, lineIndex) => ({ line: lineIndex + start + 1, text: /^(### )(.+)$/.exec(line)?.[2]?.trim() }))
      .filter((item) => item.text !== undefined);
    const actual = headings.map((item) => item.text);
    const matches = actual.length === REQUIRED_HEADINGS.length
      && actual.every((heading, index) => heading === REQUIRED_HEADINGS[index]);
    if (!matches) {
      errors.push(
        `entry "${entryStarts[entryIndex].title}" requires headings in order: ${REQUIRED_HEADINGS.join(' | ')}; found: ${actual.join(' | ') || '(none)'}`,
      );
    }
  }

  const missingPaths = [];
  const pathPattern = /`([^`\r\n]*\/[^`\r\n]+)`/g;
  let match;
  while ((match = pathPattern.exec(withoutFences)) !== null) {
    const relativePath = match[1].trim();
    const extension = path.extname(relativePath).toLowerCase();
    if (!KNOWN_EXTENSIONS.has(extension)) continue;
    const absolutePath = path.resolve(repoRoot, relativePath);
    let isFile = false;
    try {
      isFile = fs.statSync(absolutePath).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile && !missingPaths.includes(relativePath)) missingPaths.push(relativePath);
  }
  if (missingPaths.length > 0) {
    errors.push(`missing paths: ${missingPaths.join(', ')}`);
  }

  return {
    ok: errors.length === 0,
    entryCount: entryStarts.length,
    missingPaths,
    errors,
  };
}

function main() {
  const docPath = path.join(DEFAULT_REPO_ROOT, DOC_RELATIVE_PATH);
  let content;
  try {
    content = fs.readFileSync(docPath, 'utf8');
  } catch (error) {
    console.error(`FAIL ${DOC_RELATIVE_PATH}: unable to read document (${error.message})`);
    process.exitCode = 1;
    return;
  }

  const result = checkModelFacingDocs(content, DEFAULT_REPO_ROOT);
  if (!result.ok) {
    console.error(`FAIL ${DOC_RELATIVE_PATH}: entries=${result.entryCount}, missing paths=${result.missingPaths.length}`);
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`PASS ${DOC_RELATIVE_PATH}: entries=${result.entryCount}, ${result.missingPaths.length} missing paths`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const scriptPath = fileURLToPath(import.meta.url);
if (invokedPath === scriptPath || invokedPath === path.resolve(scriptPath)) {
  main();
}
