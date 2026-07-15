#!/usr/bin/env node

// 扫描目录下所有 Mach-O，任何一个缺 Developer ID 签名就 fail-closed。
// 在 tauri-release-bundle.sh 的两趟签名之后、公证之前跑：Apple 审回只说 Invalid，
// 不指名是哪个文件，这里几秒就能指名道姓。判定逻辑在 lib/macho-signature-audit.mjs。

import fs from 'node:fs';
import path from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { findUnsignedMachO } from './lib/macho-signature-audit.mjs';

function walkFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      // 不跟符号链接：.app 里 Frameworks/Versions/Current 之类的软链会把同一个二进制数很多遍。
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

function describe(filePath) {
  const fileType = spawnSync('file', ['-b', filePath], { encoding: 'utf8' }).stdout ?? '';
  // codesign 把结果打到 stderr，未签名时退出码非 0——两股都收，不看退出码。
  const codesign = spawnSync('codesign', ['-dvv', filePath], { encoding: 'utf8' });
  return { path: filePath, fileType, codesignOutput: `${codesign.stdout ?? ''}${codesign.stderr ?? ''}` };
}

function main() {
  const target = process.argv[2];
  if (!target) throw new Error('usage: verify-bundle-signatures.mjs <bundle-or-directory>');
  const root = path.resolve(target);
  if (!fs.existsSync(root)) throw new Error(`target does not exist: ${root}`);

  const entries = walkFiles(root).map(describe);
  const machO = entries.filter((entry) => entry.fileType.includes('Mach-O'));
  if (machO.length === 0) throw new Error(`no Mach-O binaries found under ${root} — scan target looks wrong`);

  const unsigned = findUnsignedMachO(entries);
  if (unsigned.length > 0) {
    const list = unsigned.map((file) => `  - ${path.relative(root, file)}`).join('\n');
    throw new Error(
      `${unsigned.length} of ${machO.length} Mach-O binaries lack a Developer ID signature; `
      + `Apple notarization will reject the bundle as Invalid:\n${list}\n`
      + 'Add the executable to the entitlements pass in scripts/tauri-release-bundle.sh.',
    );
  }
  console.log(`[bundle-signatures] passed: ${machO.length} Mach-O binaries all carry a Developer ID signature`);
}

try {
  main();
} catch (error) {
  console.error(`[bundle-signatures][FAIL] ${error.message}`);
  process.exitCode = 1;
}
