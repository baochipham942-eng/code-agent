import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  makeTauriCommandCapabilityId,
  SHELL_CAPABILITY_DOMAINS,
  shellCapabilityLayerForDomain,
} from '../src/shared/contract/shellCapabilities.ts';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

const DOMAIN_CALL_PATTERNS = [
  /\binvokeDomain(?:<[^)]*?>)?\s*\(\s*(IPC_DOMAINS\.[A-Z_]+|['"][^'"]+['"])\s*,\s*(['"])([^'"]+)\2/g,
  /\bdomainAPI\?\.invoke(?:<[^)]*?>)?\s*\(\s*(IPC_DOMAINS\.[A-Z_]+|['"][^'"]+['"])\s*,\s*(['"])([^'"]+)\2/g,
  /\bdomainAPI\.invoke(?:<[^)]*?>)?\s*\(\s*(IPC_DOMAINS\.[A-Z_]+|['"][^'"]+['"])\s*,\s*(['"])([^'"]+)\2/g,
];

const NATIVE_TAURI_CALL_PATTERNS = [
  /(?<![.\w])invoke(?:<[^)]*?>)?\s*\(\s*(['"])([a-z][a-z0-9_]*?)\1/g,
  /\btauriInvoke(?:<[^)]*?>)?\s*\(\s*(['"])([a-z][a-z0-9_]*?)\1/g,
  /\binternals\s*\.\s*invoke(?:<[^)]*?>)?\s*\(\s*(['"])([a-z][a-z0-9_]*?)\1/g,
  /\b__TAURI_INTERNALS__\??\s*\.\s*invoke(?:<[^)]*?>)?\s*\(\s*(['"])([a-z][a-z0-9_]*?)\1/g,
];

export function parseIpcDomains(source) {
  const domains = {};
  for (const match of source.matchAll(/\b([A-Z_]+):\s*'([^']+)'/g)) {
    domains[match[1]] = match[2];
  }
  return domains;
}

function collectSourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function resolveDomain(rawDomain, domains) {
  const trimmed = rawDomain.trim();
  const constant = trimmed.match(/^IPC_DOMAINS\.([A-Z_]+)$/);
  if (constant) return domains[constant[1]] ?? null;
  const literal = trimmed.match(/^['"]([^'"]+)['"]$/);
  if (!literal) return null;
  const value = literal[1];
  if (value.startsWith('domain:')) {
    return Object.values(domains).includes(value) ? value : null;
  }
  const shorthand = `domain:${value}`;
  return Object.values(domains).includes(shorthand) ? shorthand : null;
}

export function collectRendererShellCapabilities({
  rendererDir,
  domainsPath,
  repoRoot = process.cwd(),
}) {
  const domains = parseIpcDomains(fs.readFileSync(domainsPath, 'utf8'));
  const files = collectSourceFiles(rendererDir);
  const capabilities = [];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of DOMAIN_CALL_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const domain = resolveDomain(match[1], domains);
        if (!domain) continue;
        const action = match[3];
        capabilities.push({
          id: `${domain}/${action}`,
          domain,
          action,
          layer: shellCapabilityLayerForDomain(domain),
          file: path.relative(repoRoot, file),
        });
      }
    }
    for (const pattern of NATIVE_TAURI_CALL_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const command = match[2];
        capabilities.push({
          id: makeTauriCommandCapabilityId(command),
          domain: SHELL_CAPABILITY_DOMAINS.TAURI,
          action: command,
          layer: shellCapabilityLayerForDomain(SHELL_CAPABILITY_DOMAINS.TAURI),
          file: path.relative(repoRoot, file),
        });
      }
    }
  }

  return [...new Map(capabilities.map((capability) => [capability.id, capability])).values()]
    .sort((a, b) => a.id.localeCompare(b.id));
}
