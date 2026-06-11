#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, cp, mkdtemp, rm } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputRoot = path.join(rootDir, 'dist', 'bundled-node');
const targetPlatform = process.env.BUNDLED_NODE_PLATFORM || process.platform;
// 官方 win 包是顶层 node.exe（无 bin/ 目录），darwin 是 bin/node + lib/*.dylib
const outputBin = targetPlatform === 'win32'
  ? path.join(outputRoot, 'node.exe')
  : path.join(outputRoot, 'bin', 'node');
const metadataPath = path.join(outputRoot, 'agent-neo-bundled-node.json');

function normalizeVersion(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    throw new Error('Node version is empty');
  }
  return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
}

function targetTuple() {
  const platform = targetPlatform;
  const arch = process.env.BUNDLED_NODE_ARCH || process.arch;
  if (platform === 'win32') {
    if (arch !== 'x64') {
      throw new Error(`Unsupported bundled Node arch for Windows release: ${arch}`);
    }
    return { platform, arch };
  }
  if (platform !== 'darwin') {
    return null;
  }
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`Unsupported bundled Node arch for macOS release: ${arch}`);
  }
  return { platform, arch };
}

function readMetadata() {
  if (!existsSync(metadataPath)) return null;
  try {
    return JSON.parse(readFileSync(metadataPath, 'utf8'));
  } catch {
    return null;
  }
}

function runBundledNodeInfo(nodePath) {
  const output = execFileSync(nodePath, [
    '-p',
    'JSON.stringify({version: process.version, platform: process.platform, arch: process.arch, modules: process.versions.modules})',
  ], { encoding: 'utf8' });
  return JSON.parse(output);
}

async function ensureBundledNodePermissions() {
  if (targetPlatform === 'win32') return; // NTFS 无可执行位，find 在 Windows 是另一个工具
  if (existsSync(outputBin)) {
    await chmod(outputBin, 0o755);
  }
  const outputLibDir = path.join(outputRoot, 'lib');
  if (!existsSync(outputLibDir)) return;
  const files = execFileSync('find', [outputLibDir, '-type', 'f'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  for (const fileName of files) {
    await chmod(fileName, 0o644);
  }
}

function isPrepared(expected, expectedSource) {
  if (!existsSync(outputBin)) return false;
  const metadata = readMetadata();
  if (!metadata) return false;
  return metadata.version === expected.version
    && metadata.platform === expected.platform
    && metadata.arch === expected.arch
    && metadata.source === expectedSource;
}

function download(url, targetPath) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        response.resume();
        const location = response.headers.location;
        if (!location) {
          reject(new Error(`Redirect without Location for ${url}`));
          return;
        }
        download(new URL(location, url).toString(), targetPath).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
        return;
      }

      const file = createWriteStream(targetPath);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function copyProvidedNode(sourcePath, expected) {
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(path.dirname(outputBin), { recursive: true });
  await cp(sourcePath, outputBin, { force: true, dereference: true });
  await chmod(outputBin, 0o755);
  await copyProvidedNodeSharedLibraries(sourcePath);
  const info = runBundledNodeInfo(outputBin);
  if (info.platform !== expected.platform || info.arch !== expected.arch) {
    throw new Error(`Provided Node is ${info.platform}-${info.arch}, expected ${expected.platform}-${expected.arch}`);
  }
  return info;
}

function findProvidedLibrary(sourcePath, libraryName) {
  const sourceDir = path.dirname(sourcePath);
  const candidates = [
    path.join(sourceDir, libraryName),
    path.join(sourceDir, '..', 'lib', libraryName),
    path.join(sourceDir, '..', '..', 'lib', libraryName),
    path.join('/opt/homebrew/lib', libraryName),
    path.join('/usr/local/lib', libraryName),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function copyProvidedNodeSharedLibraries(sourcePath) {
  if (process.platform !== 'darwin') return;

  let output;
  try {
    output = execFileSync('otool', ['-L', sourcePath], { encoding: 'utf8' });
  } catch {
    return;
  }

  const rpathLibraries = output
    .split('\n')
    .map((line) => line.trim().match(/^@rpath\/(libnode\.[^\s]+\.dylib)/)?.[1])
    .filter(Boolean);
  if (rpathLibraries.length === 0) return;

  const outputLibDir = path.join(outputRoot, 'lib');
  mkdirSync(outputLibDir, { recursive: true });

  for (const libraryName of rpathLibraries) {
    const sourceLibrary = findProvidedLibrary(sourcePath, libraryName);
    if (!sourceLibrary) {
      throw new Error(`Provided Node requires ${libraryName}, but it was not found next to ${sourcePath}`);
    }
    const targetLibrary = path.join(outputLibDir, libraryName);
    await cp(sourceLibrary, targetLibrary, { force: true, dereference: true });
    await chmod(targetLibrary, 0o644);
  }
}

async function downloadOfficialNode(expected) {
  const isWindows = expected.platform === 'win32';
  // 官方资产名：darwin → node-vX-darwin-<arch>.tar.gz，win32 → node-vX-win-x64.zip
  const distName = `node-v${expected.version}-${isWindows ? 'win' : expected.platform}-${expected.arch}`;
  const archiveExt = isWindows ? 'zip' : 'tar.gz';
  const url = process.env.BUNDLED_NODE_URL
    || `https://nodejs.org/dist/v${expected.version}/${distName}.${archiveExt}`;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-neo-node-'));
  const archivePath = path.join(tempDir, `${distName}.${archiveExt}`);
  const extractDir = path.join(tempDir, 'extract');

  // Windows 必须显式用系统 bsdtar：Git Bash 环境下 PATH 上的 tar 是 GNU tar，
  // 会把路径里的 `C:` 当远程主机（Cannot connect to C:）且不识别 zip（CI 实跑坑）
  const tarBin = isWindows
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';

  try {
    mkdirSync(extractDir, { recursive: true });
    await download(url, archivePath);
    // -tf/-xf 自动识别压缩格式：GNU tar 读 tar.gz，bsdtar 读 zip
    const archiveEntries = execFileSync(tarBin, ['-tf', archivePath], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    const requiredEntries = new Set(isWindows
      ? [`${distName}/node.exe`, `${distName}/LICENSE`]
      : [`${distName}/bin/node`, `${distName}/LICENSE`]);
    for (const entry of archiveEntries) {
      if (!isWindows && entry.startsWith(`${distName}/lib/`) && /\/libnode\.\d+\.dylib$/.test(entry)) {
        requiredEntries.add(entry);
      }
    }

    execFileSync(tarBin, [
      '-xf',
      archivePath,
      '-C',
      extractDir,
      ...requiredEntries,
    ], { stdio: 'inherit' });

    rmSync(outputRoot, { recursive: true, force: true });
    mkdirSync(path.dirname(outputBin), { recursive: true });
    await cp(
      path.join(extractDir, distName, isWindows ? 'node.exe' : path.join('bin', 'node')),
      outputBin,
      { force: true },
    );
    await cp(path.join(extractDir, distName, 'LICENSE'), path.join(outputRoot, 'LICENSE'), { force: true });
    const extractedLibDir = path.join(extractDir, distName, 'lib');
    if (!isWindows && existsSync(extractedLibDir)) {
      await cp(extractedLibDir, path.join(outputRoot, 'lib'), { recursive: true, force: true });
      const libDir = path.join(outputRoot, 'lib');
      for (const fileName of execFileSync('find', [libDir, '-type', 'f'], { encoding: 'utf8' }).split('\n').filter(Boolean)) {
        await chmod(fileName, 0o644);
      }
    }
    if (!isWindows) {
      await chmod(outputBin, 0o755);
    }
    return runBundledNodeInfo(outputBin);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const target = targetTuple();
  if (!target) {
    console.log('[prepare-bundled-node] skipped: bundled Node is only prepared for macOS/Windows app resources');
    return;
  }

  const expected = {
    version: normalizeVersion(process.env.BUNDLED_NODE_VERSION || process.version),
    platform: target.platform,
    arch: target.arch,
  };

  const providedNode = process.env.BUNDLED_NODE_PATH;
  const source = providedNode ? 'BUNDLED_NODE_PATH' : 'nodejs.org';
  if (isPrepared(expected, source)) {
    await ensureBundledNodePermissions();
    const info = runBundledNodeInfo(outputBin);
    console.log(`[prepare-bundled-node] using cached ${outputBin} (${info.version}, ABI ${info.modules})`);
    return;
  }

  const info = providedNode
    ? await copyProvidedNode(providedNode, expected)
    : await downloadOfficialNode(expected);

  writeFileSync(metadataPath, JSON.stringify({
    version: normalizeVersion(info.version),
    platform: info.platform,
    arch: info.arch,
    modules: info.modules,
    source,
    preparedAt: new Date().toISOString(),
  }, null, 2));

  console.log(`[prepare-bundled-node] prepared ${outputBin} (${info.version}, ABI ${info.modules})`);
}

main().catch((error) => {
  console.error(`[prepare-bundled-node] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
