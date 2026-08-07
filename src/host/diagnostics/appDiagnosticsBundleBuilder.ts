// ============================================================================
// App Diagnostics Bundle Builder — 「导出诊断包」的产物组装
// ============================================================================
// 背景：Windows 用户反馈"更新后卡死"，但现有排障通道要么太浅（Doctor 页导出日志只是把
// 体检报告复制到剪贴板）要么太窄（会话诊断包 v2 只含会话窗口内的数据，不含 Tauri 壳的
// boot 诊断/生命周期事件——恰恰是"更新后启动故障"最需要的一段）。
//
// 本模块产出一个 app 级 zip，覆盖：近 7 天 host 日志、Tauri 壳 boot 诊断 + shell events、
// 近 7 天 audit、脱敏后的 config.json、环境指纹、renderer-cache 目录清单（仅元数据）、
// 可选的当次 Doctor 报告（renderer 侧已有报告时随请求带上，避免重跑一次体检）。
//
// 复用既有基础设施而非另起一套：zip 走会话包 v2 同款 JSZip；脱敏走
// packageSanitizer.sanitizePackageValue/Text（home 目录 + 密钥形态正则）叠加
// redactSensitiveKeyedFields（按字段名 key/token/secret/password/credential 整段抹除）；
// 环境指纹直接复用 diagnosticBundleService.gatherEnvFingerprint。
// ============================================================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { getAppVersion, getLogsPath, getUserDataPath } from '../platform/appPaths';
import { gatherEnvFingerprint } from '../telemetry/diagnosticBundleService';
import {
  redactSensitiveKeyedFields,
  sanitizePackageText,
  sanitizePackageValue,
} from '../session/spine/packageSanitizer';
import {
  DESKTOP_SHELL_BOOT_DIAGNOSTICS_FILE,
  DESKTOP_SHELL_EVENTS_FILE,
  resolveDesktopShellLogDir,
} from './desktopShellDiagnostics';

const DEFAULT_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AppDiagnosticsFileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface RendererCacheManifestEntry {
  path: string;
  bytes: number;
  mtime: string;
}

export interface AppDiagnosticsManifest {
  schemaVersion: 1;
  generatedAt: number;
  appVersion: string;
  windowDays: number;
  includes: {
    hostLogs: boolean;
    desktopShellBoot: boolean;
    desktopShellEvents: boolean;
    audit: boolean;
    config: boolean;
    environment: boolean;
    rendererCacheManifest: boolean;
    doctorReport: boolean;
  };
  files: AppDiagnosticsFileEntry[];
}

export interface BuildAppDiagnosticsBundleOptions {
  now?: number;
  homeDir?: string;
  windowDays?: number;
  /** host 日志目录，默认 getLogsPath()。 */
  logDir?: string;
  /** Tauri 壳 boot 诊断 / shell events 所在目录，默认 resolveDesktopShellLogDir()。 */
  shellLogDir?: string;
  /** audit 目录，默认 <userData>/audit。 */
  auditDir?: string;
  /** app 设置文件路径，默认 <userData>/config.json。 */
  configPath?: string;
  /** renderer 热更新缓存目录，默认 <userData>/renderer-cache。 */
  rendererCacheDir?: string;
  /** 环境指纹采集的工作目录，默认 process.cwd()。 */
  workingDirectory?: string;
  /** renderer 侧已有的 Doctor 报告（避免再跑一次体检），原样脱敏后随包带上。 */
  doctorReport?: unknown;
}

export interface AppDiagnosticsBundleResult {
  buffer: Buffer;
  suggestedFileName: string;
  manifest: AppDiagnosticsManifest;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** 目录下的一级文件（不递归），按 mtime 过滤窗口；目录不存在时静默返回空。 */
function listRecentFiles(dir: string, cutoffMs: number): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    try {
      if (fs.statSync(full).mtimeMs >= cutoffMs) result.push(full);
    } catch {
      // 文件在过滤期间被删除/不可读：跳过，不阻塞整包导出
    }
  }
  return result;
}

/** 递归列出目录下所有文件的元信息（不读内容），失败静默降级为空数组。 */
function walkDirManifest(dir: string, base: string = dir): RendererCacheManifestEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const output: RendererCacheManifestEntry[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      output.push(...walkDirManifest(full, base));
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = fs.statSync(full);
      output.push({
        path: path.relative(base, full).split(path.sep).join('/'),
        bytes: stat.size,
        mtime: new Date(stat.mtimeMs).toISOString(),
      });
    } catch {
      // 不可读文件跳过，清单不因单个文件失败而中断
    }
  }
  return output;
}

function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function fileName(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `neo-diagnostics-${stamp}.zip`;
}

/** app 级诊断包：与会话诊断包 v2 互补，覆盖 Tauri 壳生命周期而非单个会话窗口。 */
export async function buildAppDiagnosticsBundle(
  options: BuildAppDiagnosticsBundleOptions = {},
): Promise<AppDiagnosticsBundleResult> {
  const now = options.now ?? Date.now();
  const homeDir = options.homeDir ?? os.homedir();
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const cutoffMs = now - windowDays * DAY_MS;
  const appVersion = getAppVersion();

  const logDir = options.logDir ?? getLogsPath();
  const shellLogDir = options.shellLogDir ?? resolveDesktopShellLogDir();
  const auditDir = options.auditDir ?? path.join(getUserDataPath(), 'audit');
  const configPath = options.configPath ?? path.join(getUserDataPath(), 'config.json');
  const rendererCacheDir = options.rendererCacheDir ?? path.join(getUserDataPath(), 'renderer-cache');
  const workingDirectory = options.workingDirectory ?? process.cwd();

  const files = new Map<string, Buffer>();
  const addText = (name: string, content: string): void => { files.set(name, Buffer.from(content, 'utf8')); };

  // 1. 近 7 天 host 日志
  const hostLogFiles = listRecentFiles(logDir, cutoffMs);
  for (const filePath of hostLogFiles) {
    const content = readTextFile(filePath);
    if (content === null) continue;
    addText(`logs/${path.basename(filePath)}`, sanitizePackageText(content, 'shareable', homeDir));
  }

  // 2. Tauri 壳 boot 诊断 + shell events（同一目录，两个文件名互相独立，各自可能缺失）
  const bootDiagnosticsPath = path.join(shellLogDir, DESKTOP_SHELL_BOOT_DIAGNOSTICS_FILE);
  const bootDiagnosticsContent = readTextFile(bootDiagnosticsPath);
  if (bootDiagnosticsContent !== null) {
    addText('desktop-shell/boot-latest.json', sanitizePackageText(bootDiagnosticsContent, 'shareable', homeDir));
  }
  const shellEventsPath = path.join(shellLogDir, DESKTOP_SHELL_EVENTS_FILE);
  const shellEventsContent = readTextFile(shellEventsPath);
  if (shellEventsContent !== null) {
    addText('desktop-shell/events.ndjson', sanitizePackageText(shellEventsContent, 'shareable', homeDir));
  }

  // 3. 近 7 天 audit
  const auditFiles = listRecentFiles(auditDir, cutoffMs);
  for (const filePath of auditFiles) {
    const content = readTextFile(filePath);
    if (content === null) continue;
    addText(`audit/${path.basename(filePath)}`, sanitizePackageText(content, 'shareable', homeDir));
  }

  // 4. config.json 脱敏副本：先按字段名整段抹除 key/token/secret/password/credential，
  //    再走通用脱敏（home 目录 + 密钥形态正则）兜底
  const configRaw = readTextFile(configPath);
  let hasConfig = false;
  if (configRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(configRaw);
      const keyRedacted = redactSensitiveKeyedFields(parsed);
      const sanitized = sanitizePackageValue(keyRedacted, 'shareable', homeDir);
      addText('config.sanitized.json', json(sanitized));
      hasConfig = true;
    } catch {
      // 配置文件损坏/非 JSON：跳过，不阻塞整包导出
    }
  }

  // 5. 环境指纹
  const environment = sanitizePackageValue(await gatherEnvFingerprint(workingDirectory), 'shareable', homeDir);
  addText('environment.json', json(environment));

  // 6. renderer-cache 目录清单（仅文件名/大小/mtime，不拷内容）
  const rendererCacheManifest = walkDirManifest(rendererCacheDir);
  addText('renderer-cache-manifest.json', json(rendererCacheManifest));

  // 7. 可选：renderer 侧已有的 Doctor 报告
  const hasDoctorReport = options.doctorReport !== undefined && options.doctorReport !== null;
  if (hasDoctorReport) {
    addText('doctor-report.json', json(sanitizePackageValue(options.doctorReport, 'shareable', homeDir)));
  }

  addText('README.txt', [
    'Neo app diagnostics package',
    `Generated: ${new Date(now).toISOString()}`,
    `Window: last ${windowDays} days`,
    '',
    'logs/            host 进程日志（近 7 天，按 mtime 过滤）',
    'desktop-shell/   Tauri 壳 boot 诊断 + 生命周期事件（若存在）',
    'audit/           安全审计日志（近 7 天）',
    'config.sanitized.json   应用设置副本，key/token/secret/password/credential 字段已抹除',
    'environment.json        操作系统/Node/应用版本/git 状态指纹',
    'renderer-cache-manifest.json  renderer 热更新缓存目录清单（仅元数据，不含内容）',
    hasDoctorReport ? 'doctor-report.json      导出时的体检报告' : null,
    '',
    '本包内容已脱敏（home 目录替换为 ~，密钥形态字符串与敏感字段值已抹除），仍可能包含',
    '项目路径、命令历史等信息，请仅发送给可信的开发/支持人员。',
  ].filter((line): line is string => line !== null).join('\n'));

  const manifest: AppDiagnosticsManifest = {
    schemaVersion: 1,
    generatedAt: now,
    appVersion,
    windowDays,
    includes: {
      hostLogs: hostLogFiles.length > 0,
      desktopShellBoot: bootDiagnosticsContent !== null,
      desktopShellEvents: shellEventsContent !== null,
      audit: auditFiles.length > 0,
      config: hasConfig,
      environment: true,
      rendererCacheManifest: true,
      doctorReport: hasDoctorReport,
    },
    files: [...files.entries()].map(([name, content]) => ({
      path: name,
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: content.byteLength,
    })),
  };
  addText('manifest.json', json(manifest));

  const zip = new JSZip();
  for (const [name, content] of files) zip.file(name, content);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, suggestedFileName: fileName(now), manifest };
}
