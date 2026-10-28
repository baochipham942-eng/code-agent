import fs from 'fs';
import path from 'path';
import type { createLogger } from '../services/infra/logger';

/**
 * ADR-086:原生依赖位置由构建期清单(dist/native/manifest.json)声明,不再运行时试探。
 * 本模块是 bundle 模式的读取方;writer 是 scripts/gen-native-dep-manifest.mjs(T1)。
 * 源码模式(清单缺席)不是错误,返回 null,调用方走纯包解析(ADR-086 §4.5)。
 */

const BUNDLED_RUNTIME_ROOT_ENV = 'AGENT_NEO_BUNDLED_RUNTIME_ROOT';
const RESOURCE_DIR_ENV = 'AGENT_NEO_RESOURCE_DIR';
const MANIFEST_KIND = 'agent_neo_native_dep_manifest';
const MANIFEST_SCHEMA_VERSION = 1;

type Logger = Pick<ReturnType<typeof createLogger>, 'debug'>;

/** manifest.json 的 modules 条目(schema 见 ADR-086 §4.1)。 */
interface NativeDepManifestEntry {
  kind: string;
  entry: string;
  native?: string;
  packageVersion?: string;
}

/** 读取成功的清单快照;所有路径已解析为绝对路径。 */
interface NativeDepManifest {
  manifestPath: string;
  root: string;
  platform: string;
  generatedAt?: string;
  modules: Record<string, NativeDepManifestEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeRoot(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

function missingManifestError(manifestPath: string, cause: unknown): Error {
  return new Error(
    `[native-dep-manifest] bundle mode but manifest is missing: expected ${manifestPath}. This app bundle is incomplete (packaging bug). Fix: rebuild the bundle so scripts/gen-native-dep-manifest.mjs runs (tauri:package / tauri:package:dev chains). Do not hand-patch the bundle.`,
    { cause },
  );
}

/**
 * 读清单。bundle 模式 = AGENT_NEO_BUNDLED_RUNTIME_ROOT 与 AGENT_NEO_RESOURCE_DIR 同时非空:
 * Rust 壳起 webServer 时两变量必同时设置;18 处非壳 harness 只设前者指向源码 checkout,
 * 单变量判据会把它们误判进 bundle 模式并对不存在的清单 throw(ADR-086 §4.3 T2 细化)。
 *
 * bundle 模式下清单缺失/损坏/平台不符直接 throw(ADR-086 §4.4,无静默回退);
 * 源码模式返回 null,至多一行 debug 日志。
 */
export function readNativeDepManifest(
  env: NodeJS.ProcessEnv = process.env,
  logger?: Logger,
): NativeDepManifest | null {
  const root = normalizeRoot(env[BUNDLED_RUNTIME_ROOT_ENV]);
  const resourceDir = normalizeRoot(env[RESOURCE_DIR_ENV]);
  if (!root || !resourceDir) {
    logger?.debug(
      `[native-dep-manifest] bundle mode inactive (${BUNDLED_RUNTIME_ROOT_ENV}/${RESOURCE_DIR_ENV} not both set); native deps resolve from node_modules`,
    );
    return null;
  }

  const manifestPath = path.join(root, 'dist', 'native', 'manifest.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw missingManifestError(manifestPath, error);
  }
  if (
    !isRecord(parsed) ||
    parsed.kind !== MANIFEST_KIND ||
    parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    !isRecord(parsed.modules)
  ) {
    throw missingManifestError(
      manifestPath,
      `invalid manifest: kind=${String(parsed && isRecord(parsed) ? parsed.kind : parsed)} schemaVersion=${
        parsed && isRecord(parsed) ? String(parsed.schemaVersion) : 'n/a'
      }`,
    );
  }

  const platform = `${process.platform}-${process.arch}`;
  if (parsed.platform !== platform) {
    throw new Error(
      `[native-dep-manifest] manifest platform ${String(parsed.platform)} does not match this process ${platform}; wrong overlay used at build time. Fix: rebuild with the matching arch/platform overlay.`,
    );
  }

  return {
    manifestPath,
    root,
    platform,
    generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : undefined,
    modules: parsed.modules as Record<string, NativeDepManifestEntry>,
  };
}

/**
 * 按模块 id 取声明的绝对 entry 路径;路径不存在即 throw(ADR-086 §4.4 装配不一致)。
 */
export function resolveNativeDepEntry(manifest: NativeDepManifest, moduleId: string): string {
  const entry = manifest.modules[moduleId];
  const declaredAt = entry?.entry
    ? path.join(manifest.root, entry.entry)
    : `${manifest.manifestPath} (no '${moduleId}' entry declared)`;
  if (!entry?.entry || !fs.existsSync(declaredAt)) {
    throw new Error(
      `[native-dep-manifest] module '${moduleId}' is declared at ${declaredAt} but the path is missing (manifest platform=${manifest.platform}, generatedAt=${
        manifest.generatedAt ?? 'unknown'
      }). The bundle was assembled inconsistently. Fix: rebuild the bundle; manifest entries must match the shipped files.`,
    );
  }
  return declaredAt;
}
