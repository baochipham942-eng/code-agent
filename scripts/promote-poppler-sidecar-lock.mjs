#!/usr/bin/env node

// 从双架构候选目录算出 ready lock。只读候选文件 + 写出 lock，不碰网络、不改仓库：
// 上传由 promote-poppler-sidecar.yml 做，lock 提交由人复核后做（ADR-040 C2a 的人工闸）。

import fs from 'node:fs';
import path from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  assertCrossPlatformComponentParity,
  buildReadyPopplerLock,
  sha256File,
} from './lib/poppler-sidecar-release.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = {
    lock: path.join(repoRoot, 'config/poppler-sidecar.lock.json'),
    out: null,
    artifactBaseUrl: null,
    dirs: {},
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--lock' && value) options.lock = path.resolve(value);
    else if (arg === '--out' && value) options.out = path.resolve(value);
    else if (arg === '--artifact-base-url' && value) options.artifactBaseUrl = value;
    else if (arg === '--darwin-arm64-dir' && value) options.dirs['darwin-arm64'] = path.resolve(value);
    else if (arg === '--darwin-x64-dir' && value) options.dirs['darwin-x64'] = path.resolve(value);
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
    index += 1;
  }
  for (const [name, value] of Object.entries({ '--out': options.out, '--artifact-base-url': options.artifactBaseUrl })) {
    if (!value) throw new Error(`${name} is required`);
  }
  for (const platform of ['darwin-arm64', 'darwin-x64']) {
    if (!options.dirs[platform]) throw new Error(`--${platform}-dir is required`);
  }
  return options;
}

// 候选文件名由 build-poppler-sidecar-artifacts.mjs 按 platform+version 铸出，这里按同一
// 规则回推。名字对不上就 fail：宁可停在这儿，也不能把猜错的文件名写进 lock 的 url。
function describeCandidate(dir, platform, version) {
  const names = {
    manifest: `poppler-sidecar-manifest-${platform}.json`,
    sidecarArchive: `poppler-sidecar-${platform}-${version}.tar.gz`,
    sourceBundle: `poppler-complete-source-${platform}-${version}.tar.gz`,
  };
  return Object.fromEntries(Object.entries(names).map(([kind, name]) => {
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) throw new Error(`Candidate ${platform} is missing ${name} in ${dir}`);
    return [kind, { name, sha256: sha256File(full), bytes: fs.statSync(full).size }];
  }));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const pendingLock = JSON.parse(fs.readFileSync(options.lock, 'utf8'));
  const version = pendingLock.popplerBrewVersion;
  const candidateFiles = Object.fromEntries(
    Object.entries(options.dirs).map(([platform, dir]) => [platform, describeCandidate(dir, platform, version)]),
  );
  // 两架构装的依赖版本对不齐就别 promote：不可变路径一旦占住就没有回头路。
  assertCrossPlatformComponentParity(Object.fromEntries(
    Object.entries(options.dirs).map(([platform, dir]) => [
      platform,
      JSON.parse(fs.readFileSync(path.join(dir, `poppler-sidecar-manifest-${platform}.json`), 'utf8')),
    ]),
  ));
  const readyLock = buildReadyPopplerLock(pendingLock, { artifactBaseUrl: options.artifactBaseUrl, candidateFiles });
  fs.writeFileSync(options.out, `${JSON.stringify(readyLock, null, 2)}\n`);
  console.log(`Wrote ready Poppler lock for ${version} to ${options.out}`);
}

try {
  main();
} catch (error) {
  console.error(`[poppler-lock-promote][FAIL] ${error.message}`);
  process.exitCode = 1;
}
