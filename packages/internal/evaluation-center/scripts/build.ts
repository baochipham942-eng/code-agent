import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build as viteBuild } from 'vite';
import { buildHostBundle } from '../esbuild.host.config';
import rendererConfig from '../vite.renderer.config';
import { assertPluginBundle } from './assert-plugin-bundle';

const packageRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(packageRoot, '../../..');

interface SdkVersion {
  host: string;
  renderer: string;
}

function readSdkVersion(source: string): SdkVersion {
  const match = source.match(/INTERNAL_SDK_VERSION\s*=\s*Object\.freeze\(\{[\s\S]*?host:\s*['"]([^'"]+)['"][\s\S]*?renderer:\s*['"]([^'"]+)['"]/u);
  if (!match) throw new Error('无法从 internalSdkVersion.ts 读取 INTERNAL_SDK_VERSION');
  return { host: match[1], renderer: match[2] };
}

export async function buildPlugin(): Promise<void> {
  const sourceManifestPath = path.join(packageRoot, 'plugin.json');
  const sourceManifestBeforeBuild = await fs.readFile(sourceManifestPath);
  await Promise.all([
    viteBuild(rendererConfig),
    buildHostBundle(),
  ]);

  const [manifestText, appPackageText, sdkSource] = await Promise.all([
    fs.readFile(sourceManifestPath, 'utf8'),
    fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    fs.readFile(path.join(repositoryRoot, 'src/host/internalFeatures/internalSdkVersion.ts'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  const appPackage = JSON.parse(appPackageText) as { version?: unknown };
  if (typeof appPackage.version !== 'string') throw new Error('主仓 package.json 缺少 version');
  const commit = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim();
  const sdkVersion = readSdkVersion(sdkSource);
  const feature = manifest.internalFeature as Record<string, unknown> | undefined;
  if (!feature) throw new Error('plugin.json 缺少 internalFeature');
  manifest.version = `${appPackage.version}+${commit}`;
  feature.sdkVersion = sdkVersion;
  feature.rendererEntry = 'dist/renderer/index.js';
  feature.rendererStyles = 'dist/renderer/index.css';
  feature.hostEntry = 'dist/host/index.cjs';
  feature.builtFrom = { appVersion: appPackage.version, commit };
  await fs.writeFile(
    path.join(packageRoot, 'dist', 'plugin.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  assertPluginBundle(packageRoot);
  const sourceManifestAfterBuild = await fs.readFile(sourceManifestPath);
  if (!sourceManifestAfterBuild.equals(sourceManifestBeforeBuild)) {
    throw new Error(
      `构建产物泄漏回源码：${sourceManifestPath} 被改写；源码只留 unbuilt 占位，真实指纹只进 dist/`,
    );
  }
  process.stdout.write(`[evaluation-center] built ${manifest.version}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void buildPlugin().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
