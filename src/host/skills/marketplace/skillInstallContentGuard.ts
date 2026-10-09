import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../../services/infra/logger';
import { scanSkillContent, type SkillGuardFinding } from '../../security/skillContentGuard';
import type { SkillInstallCautionHit } from '../../../shared/contract/skillInstallCaution';
import type { MarketplaceSource } from './types';

/**
 * 来源只用于审计/扫描策略，不会把任何远端内容视为免检：
 * builtin：编译进应用，本服务没有 builtin 安装入口；
 * official-registry：官方 registry 的 pinned commit/hash 路径；本模块不把它冒充密码学签名来源；
 * unsigned-github-archive：普通 GitHub archive 没有签名，只做完整性/TOFU 校验；
 * local-marketplace：本机目录、URL manifest 等用户管理来源，没有密码学签名。
 */
export type SkillInstallSourceTrust =
  | 'builtin'
  | 'official-registry'
  | 'unsigned-github-archive'
  | 'local-marketplace';

const logger = createLogger('SkillInstallContentGuard');
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const TEXT_FILE_EXTENSIONS = new Set([
  '.bash', '.c', '.cjs', '.conf', '.cpp', '.css', '.fish', '.go', '.h', '.hpp',
  '.html', '.ini', '.java', '.js', '.json', '.jsx', '.md', '.mjs', '.php', '.pl',
  '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.svelte', '.swift', '.toml', '.ts',
  '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml', '.zsh', '.hook', '.command',
]);

export class SkillContentScanBlockedError extends Error {
  readonly code = 'SKILL_CONTENT_SCAN_BLOCKED';

  constructor(pluginSpec: string, sourceTrust: SkillInstallSourceTrust, filePath: string) {
    // Keep the host-facing error stable and localization-neutral. Detailed
    // findings stay in the guarded log and never become renderer copy.
    super(`SKILL_CONTENT_SCAN_BLOCKED: plugin '${pluginSpec}' from ${sourceTrust} was rejected before activation (${filePath})`);
    this.name = 'SkillContentScanBlockedError';
  }
}

export class SkillContentScanFailedError extends Error {
  readonly code = 'SKILL_CONTENT_SCAN_FAILED';

  constructor(pluginSpec: string, sourceTrust: SkillInstallSourceTrust, filePath: string) {
    super(`SKILL_CONTENT_SCAN_FAILED: plugin '${pluginSpec}' from ${sourceTrust} could not be scanned (${filePath})`);
    this.name = 'SkillContentScanFailedError';
  }
}

export function classifySkillInstallSource(args: {
  source?: MarketplaceSource;
}): SkillInstallSourceTrust {
  if (args.source?.source === 'github') return 'unsigned-github-archive';
  return 'local-marketplace';
}

export function parseGitHubRepository(repository?: string): { owner: string; repo: string } | null {
  if (!repository) return null;
  const trimmed = repository.trim().replace(/\.git$/, '');
  const match = trimmed.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)$/)
    ?? trimmed.match(/^github:([^/\s]+)\/([^/\s#?]+)$/)
    ?? trimmed.match(/^([^/\s]+)\/([^/\s#?]+)$/);
  return match ? { owner: match[1]!, repo: match[2]! } : null;
}

export function getPluginAssetDirName(pluginSpec: string): string {
  return pluginSpec
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/g, '-')
    .replace(/@/g, '__')
    .replace(/^-+|-+$/g, '') || 'plugin';
}

async function readTextFiles(rootDir: string): Promise<Array<{ relativePath: string; content: string }>> {
  const files: Array<{ relativePath: string; content: string }> = [];

  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`SKILL_CONTENT_SCAN_BLOCKED: symbolic link rejected (${path.relative(rootDir, filePath)})`);
      }
      if (stat.isDirectory()) {
        await walk(filePath);
        continue;
      }
      if (!stat.isFile()) continue;
      const relativePath = path.relative(rootDir, filePath);
      const extension = path.extname(entry.name).toLowerCase();
      if (extension && !TEXT_FILE_EXTENSIONS.has(extension)) {
        logger.debug('Skipped non-whitelisted install file', { file: relativePath });
        continue;
      }
      if (stat.size > MAX_TEXT_FILE_BYTES) {
        throw new Error(`SKILL_CONTENT_SCAN_BLOCKED: text file exceeds scan limit (${relativePath})`);
      }
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(filePath);
      } catch {
        throw new Error(`SKILL_CONTENT_SCAN_FAILED: unable to read install file (${relativePath})`);
      }
      if (bytes.includes(0)) {
        logger.debug('Skipped binary install file', { file: relativePath });
        continue;
      }
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        logger.debug('Skipped non-UTF8 install file', { file: relativePath });
        continue;
      }
      files.push({ relativePath, content });
    }
  }

  await walk(rootDir);
  return files;
}

/** sha256 of sorted relativePath + NUL + content + NUL pairs. Empty input hashes no bytes. */
function hashScannedText(files: Array<{ relativePath: string; content: string }>): string {
  const hash = createHash('sha256');
  const sorted = [...files].sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  for (const file of sorted) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(file.content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

interface SkillInstallScanResult {
  cautionHits: SkillInstallCautionHit[];
  /** Hash of the text files this scan actually read. Confirmation tokens bind to it. */
  contentHash: string;
}

export interface SkillPluginRootScanOutcome extends SkillInstallScanResult {
  verdict: 'pass' | 'block';
  findings: SkillGuardFinding[];
  /** 命中阻断的相对文件路径（verdict=block 时存在） */
  file?: string;
}

/**
 * 扫描一个已落盘的插件根目录，返回判定结果而不抛阻断错。
 * builtin 与 scanInstallContent 一致直接判 pass（builtin 资产编译进应用，
 * 不经过 marketplace 落盘扫描）。读取失败仍按 fail-closed 抛
 * SkillContentScanFailedError / SKILL_CONTENT_SCAN_BLOCKED 前缀错误。
 */
export async function scanPluginRootContent(args: {
  pluginSpec: string;
  sourceTrust: SkillInstallSourceTrust;
  rootDir: string;
}): Promise<SkillPluginRootScanOutcome> {
  if (args.sourceTrust === 'builtin') {
    return { verdict: 'pass', findings: [], cautionHits: [], contentHash: hashScannedText([]) };
  }

  let files: Array<{ relativePath: string; content: string }>;
  try {
    files = await readTextFiles(args.rootDir);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SKILL_CONTENT_SCAN_BLOCKED:')) {
      throw error;
    }
    const filePath = error instanceof Error ? error.message.match(/\(([^()]*)\)$/)?.[1] ?? args.rootDir : args.rootDir;
    throw new SkillContentScanFailedError(args.pluginSpec, args.sourceTrust, filePath);
  }

  const contentHash = hashScannedText(files);
  const cautionHits: SkillInstallCautionHit[] = [];
  for (const file of files) {
    const result = scanSkillContent(file.content);
    if (result.verdict === 'block') {
      return { verdict: 'block', findings: result.findings, file: file.relativePath, cautionHits, contentHash };
    }
    // Plugin-root verdict stays pass|block for rescan. Caution is pass there;
    // install reads cautionHits and applies the source policy.
    for (const finding of result.findings) {
      if (!finding.ruleId || finding.snippet === undefined) continue;
      cautionHits.push({ file: file.relativePath, ruleId: finding.ruleId, snippet: finding.snippet });
    }
  }
  return { verdict: 'pass', findings: [], cautionHits, contentHash };
}

export async function scanInstallContent(args: {
  pluginSpec: string;
  sourceTrust: SkillInstallSourceTrust;
  rootDir: string;
}): Promise<SkillInstallScanResult> {
  // builtin assets never reach this marketplace staging path. Keep this branch
  // explicit so a future builtin caller cannot create a second policy.
  if (args.sourceTrust === 'builtin') {
    return { cautionHits: [], contentHash: hashScannedText([]) };
  }

  const outcome = await scanPluginRootContent(args);
  if (outcome.verdict !== 'block') {
    return { cautionHits: outcome.cautionHits, contentHash: outcome.contentHash };
  }

  logger.warn('Marketplace install blocked by skill content guard', {
    pluginSpec: args.pluginSpec,
    sourceTrust: args.sourceTrust,
    file: outcome.file,
    findings: outcome.findings.map((finding) => finding.kind),
  });
  throw new SkillContentScanBlockedError(args.pluginSpec, args.sourceTrust, outcome.file ?? args.rootDir);
}
