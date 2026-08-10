import { existsSync, globSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ============================================================================
// tauri.conf.json 的 bundle.resources 路径存在性门
// ============================================================================
//
// 背景：tauri-build 在 build.rs 阶段校验 bundle.resources 每一条都能命中文件，
// 命不中就直接构建失败——而这只在 macOS/Windows 构建腿上才跑。#380 把
// `../scripts/poppler` 加进 base conf 时漏了 win32 剔除，Windows 构建自那天起
// 一直炸在「resource path doesn't exist」，直到 v0.27.2 真发版才暴露。
// 2026-08-10 sharp 0.34→0.35 同样撞上两条：`sharp/lib/*.js` 在 0.35 里命中
// 0 个文件（JS 挪去了 dist/），`sharp/node_modules/semver` 目录整个消失
// （被提升到顶层）。两条都是靠人手工 ls 才发现的。
//
// 这道门把「路径还在不在」提前到本地与 PR CI。
//
// 平台专属 optional 包（`@img/sharp-darwin-arm64` 等）在别的平台上根本不会安装，
// 而 Swarm CI 跑 Linux —— 这类按「整个包根都不在」跳过，名单从 sharp 自己的
// optionalDependencies 推导，不硬编码（与 resourcesDependencyClosure 同一套判法）。
// 🔴 划清界限：**只有包根整个不在才算平台没装**；包根在、子路径没了就是真断裂，
// 照红不误——sharp 0.35 的 lib/*.js 与 node_modules/semver 正是后者。这条有专门
// 的用例钉着，别为了让 CI 变绿把它放宽成「包名匹配就跳过」。
//
// 🔴 已知盲区（写在这里，不要以为它覆盖了）：
//   - 只检查 base conf（macOS/arm64 形态）。win32-x64 与 darwin-x64 的派生配置
//     指向本机没装的包（@img/sharp-win32-x64 等），存在性无从检查；那两条的
//     结构一致性由 releaseMacosGates.test.ts 的映射断言覆盖。
//   - 只回答「命中了至少一个文件」，不回答「命中的内容对不对」。
//   - **抓不到「该打包却没写进 conf」这一类**。同一批里 sharp 的第三条断裂
//     （@img/sharp-darwin-arm64/index.cjs 没被列进来）就属于这类：列表里少一条，
//     静态上无从判断。那类只有打包后真跑（两条发版腿）能照出来。
// ============================================================================

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const tauriConfigPath = join(repoRoot, 'src-tauri/tauri.conf.json');

// 构建产物 / 拉取的 sidecar：干净 checkout 上本来就不存在，豁免存在性检查。
// 这是**保留清单**不是拒绝清单——新增的 resources 条目默认落进「必须存在」，
// 要豁免必须显式登记并写清由谁生成。
const BUILD_ARTIFACT_SOURCES = new Map<string, string>([
  ['../dist/web/webServer.cjs', 'npm run build:web'],
  ['../dist/web/webServer.bundle.cjs', 'npm run build:web'],
  ['../dist/web/control-plane-public-keys.json', 'npm run build:web'],
  ['../dist/native', 'npm run rebuild-native:system'],
  ['../dist/bundled-node', 'npm run rebuild-native:system'],
  ['../dist/renderer', 'npm run build:renderer'],
  ['../scripts/system-audio-capture', 'scripts/build-audio-capture.sh'],
  ['../scripts/voice-aec-io', 'scripts/build-audio-capture.sh'],
  ['../scripts/vision-ocr', 'scripts/build-audio-capture.sh'],
  ['../scripts/vision-tagger', 'scripts/build-audio-capture.sh'],
  ['../scripts/rtk', 'scripts/fetch-rtk.sh'],
  ['../scripts/uv', 'scripts/fetch-uv.sh'],
  ['../scripts/poppler', 'scripts/fetch-poppler.sh'],
  ['../.tauri-resources.noindex/scripts/Agent Neo Computer Use.app', 'scripts/fetch-cua-driver.sh'],
]);

type TauriResources = string[] | Record<string, string | null>;

function readTauriResources(): TauriResources {
  const config = JSON.parse(readFileSync(tauriConfigPath, 'utf8')) as {
    bundle?: { resources?: TauriResources };
  };
  return config.bundle?.resources ?? [];
}

function resourceSources(resources: TauriResources): string[] {
  return Array.isArray(resources)
    ? [...resources]
    : Object.entries(resources).flatMap(([source, target]) => (typeof target === 'string' ? [source] : []));
}

/** conf 里的 source 是相对 src-tauri/ 写的（`../` 开头），换算成仓根相对路径。 */
function toRepoRelative(source: string): string {
  return source.startsWith('../') ? source.slice(3) : join('src-tauri', source);
}

/** `node_modules/@img/sharp-darwin-arm64/lib` → `@img/sharp-darwin-arm64`；非 node_modules 路径返回 null。 */
export function packageNameOf(repoRelativePath: string): string | null {
  const marker = 'node_modules/';
  const at = repoRelativePath.lastIndexOf(marker);
  if (at < 0) return null;
  const segments = repoRelativePath.slice(at + marker.length).split('/');
  if (segments.length === 0 || segments[0] === '') return null;
  return segments[0].startsWith('@') && segments.length > 1
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
}

type PathProbe = (repoRelativePath: string) => boolean;

/** 读一个已安装包的 optionalDependencies；读不到返回空表。 */
type OptionalDepsReader = (packageName: string) => string[];

const realProbe: PathProbe = (repoRelativePath) => {
  const absolute = join(repoRoot, repoRelativePath);
  if (existsSync(absolute)) return true;
  // 带 glob 的条目（`dist/*.cjs`、`lib/*.js`）必须真命中文件才算存在——
  // 命中 0 个是 sharp 0.35 那条断裂的形状，不能当通过。
  return globSync(absolute).length > 0;
};

const realOptionalDepsReader: OptionalDepsReader = (packageName) => {
  const manifest = join(repoRoot, 'node_modules', packageName, 'package.json');
  if (!existsSync(manifest)) return [];
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
      optionalDependencies?: Record<string, string>;
    };
    return Object.keys(parsed.optionalDependencies ?? {});
  } catch {
    return [];
  }
};

export function assertResourcePathsExist(
  resources: TauriResources,
  registry: ReadonlyMap<string, string>,
  probe: PathProbe,
  readOptionalDeps: OptionalDepsReader,
): { exempted: string[]; skippedForPlatform: string[] } {
  const sources = resourceSources(resources);
  if (sources.length === 0) {
    throw new Error('bundle.resources 解析出 0 条；conf 结构或解析器已失效，不能静默通过。');
  }

  // base conf 是 macOS/arm64 形态，`@img/sharp-darwin-arm64` 这类平台专属包在别的
  // 平台上（Swarm CI 跑 Linux）根本不会安装。判据不硬编码平台名单：从 conf 引用到的、
  // **本机装得上的**包各自的 optionalDependencies 里推导出「哪些是平台可选的」。
  const platformOptional = new Set<string>();
  for (const source of sources) {
    const name = packageNameOf(toRepoRelative(source));
    if (name) for (const dep of readOptionalDeps(name)) platformOptional.add(dep);
  }

  const missing: string[] = [];
  const exempted: string[] = [];
  const skippedForPlatform: string[] = [];
  const nodeModulesExemptions: string[] = [];

  for (const source of sources) {
    const repoRelative = toRepoRelative(source);
    if (probe(repoRelative)) continue;

    // 🔴 只有「整个包根都不在」才算平台没装。包根在、子路径没了 = 真断裂（sharp 0.35
    // 的 lib/*.js 与 node_modules/semver 正是这个形状），绝不能被平台豁免吃掉。
    const name = packageNameOf(repoRelative);
    if (name && platformOptional.has(name) && !probe(`node_modules/${name}`)) {
      skippedForPlatform.push(source);
      continue;
    }

    const producer = registry.get(source);
    if (producer) {
      exempted.push(source);
      continue;
    }
    missing.push(source);
  }

  // node_modules 下的东西 npm ci 一定装得出来，不存在「构建产物」这种解释。
  // 允许它进豁免表 = 给 sharp 那类断裂留后门。
  for (const source of registry.keys()) {
    if (toRepoRelative(source).startsWith('node_modules/')) nodeModulesExemptions.push(source);
  }

  const staleExemptions = [...registry.keys()].filter((source) => !sources.includes(source));

  const failures: string[] = [];
  if (missing.length > 0) {
    failures.push(`bundle.resources 指向不存在的路径（tauri build 会当场失败）：\n- ${missing.join('\n- ')}`);
  }
  if (nodeModulesExemptions.length > 0) {
    failures.push(`node_modules 路径不得进构建产物豁免表：\n- ${nodeModulesExemptions.join('\n- ')}`);
  }
  if (staleExemptions.length > 0) {
    failures.push(`豁免表里有 conf 已不再引用的条目，请删掉：\n- ${staleExemptions.join('\n- ')}`);
  }
  if (failures.length > 0) throw new Error(failures.join('\n\n'));

  return { exempted, skippedForPlatform };
}

const noOptionalDeps: OptionalDepsReader = () => [];

describe('Tauri bundle.resources 路径存在性', () => {
  it('每一条 resources 都能命中文件，构建产物只走显式豁免', () => {
    expect(() => assertResourcePathsExist(
      readTauriResources(),
      BUILD_ARTIFACT_SOURCES,
      realProbe,
      realOptionalDepsReader,
    )).not.toThrow();
  });

  it('解析出 0 条时报红，而不是静默通过', () => {
    expect(() => assertResourcePathsExist({}, BUILD_ARTIFACT_SOURCES, () => true, noOptionalDeps))
      .toThrowError(/解析出 0 条/);
  });

  it('未登记的路径缺失时报红', () => {
    expect(() => assertResourcePathsExist(
      { '../node_modules/sharp/lib/*.js': 'node_modules/sharp/lib' },
      new Map(),
      () => false,
      noOptionalDeps,
    )).toThrowError(/指向不存在的路径/);
  });

  it('拒绝把 node_modules 路径塞进构建产物豁免表', () => {
    expect(() => assertResourcePathsExist(
      { '../node_modules/sharp/lib/*.js': 'node_modules/sharp/lib' },
      new Map([['../node_modules/sharp/lib/*.js', '假装它是构建产物']]),
      () => false,
      noOptionalDeps,
    )).toThrowError(/不得进构建产物豁免表/);
  });

  it('平台专属的 optional 包整包没装时跳过，不报红', () => {
    const result = assertResourcePathsExist(
      {
        '../node_modules/sharp/package.json': 'node_modules/sharp/package.json',
        '../node_modules/@img/sharp-darwin-arm64/lib': 'node_modules/@img/sharp-darwin-arm64/lib',
      },
      new Map(),
      // sharp 装上了，平台包整个不在（Linux runner 的真实形状）
      (p) => p.startsWith('node_modules/sharp/'),
      (name) => (name === 'sharp' ? ['@img/sharp-darwin-arm64'] : []),
    );
    expect(result.skippedForPlatform).toEqual(['../node_modules/@img/sharp-darwin-arm64/lib']);
  });

  it('🔴 包根在、子路径没了仍然报红——平台豁免不许吃掉真断裂', () => {
    expect(() => assertResourcePathsExist(
      { '../node_modules/@img/sharp-darwin-arm64/index.cjs': 'node_modules/@img/sharp-darwin-arm64/index.cjs' },
      new Map(),
      // 包根在（平台对得上），只有子路径不在 —— 这正是 sharp 0.35 那两条的形状
      (p) => p === 'node_modules/@img/sharp-darwin-arm64',
      () => ['@img/sharp-darwin-arm64'],
    )).toThrowError(/指向不存在的路径/);
  });

  it('豁免表里留下 conf 已不引用的条目时报红', () => {
    expect(() => assertResourcePathsExist(
      { '../package.json': 'package.json' },
      new Map([['../scripts/已删掉的东西', 'some-script.sh']]),
      () => true,
      noOptionalDeps,
    )).toThrowError(/已不再引用/);
  });
});
