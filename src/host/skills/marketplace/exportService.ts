// ============================================================================
// Skill Export Service
// ============================================================================
// 把已安装 skill（user/project scope，按现有 discovery）打成 SKILL.md ZIP 导出包。
// 只生产、不安装：装回必须走现有 installService + extractZipSafely（禁止第三条
// 安装链，ADR-048 红线），包形状刻意对齐 installService 认得的 skill 目录结构。
//
// 包形状：
//   <skillDirName>/SKILL.md        ← 恰好一份，位于单顶层目录根部
//   <skillDirName>/<同目录资源>     ← 递归包含
//   _meta.json                     ← { name, version?, contentHash }
//
// contentHash = sha256(仅含 skill 内容的 payload zip，不含 _meta.json)。ZIP 生成
// 用固定时间戳（1980-01-01）保证字节确定性，接收方可对解包后的目录重新打包复核
// 同一 hash。_meta.json 若计入自身所在包的 hash 会自指，故 hash 只覆盖 payload。
// ============================================================================

import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { createLogger } from '../../services/infra/logger';
import { getSkillDiscoveryService } from '../../services/skills/skillDiscoveryService';
import { getUserConfigDir } from '../../config/configPaths';
import type { ParsedSkill, SkillSource } from '../../../shared/contract/agentSkill';
import { getArchiveSha256 } from './githubArchiveSecurity';

const logger = createLogger('SkillExportService');

/** 导出包仅覆盖本机 user/project skill；builtin/cloud/library/plugin 不导出 */
const EXPORTABLE_SKILL_SOURCES: ReadonlySet<SkillSource> = new Set<SkillSource>(['user', 'project']);

/** ZIP 时间戳固定为 DOS epoch：同内容重复打包字节一致，hash 才可复核 */
const FIXED_ZIP_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

const SKILL_EXPORT_UNSAFE_ENTRY = 'SKILL_EXPORT_UNSAFE_ENTRY';
const SKILL_EXPORT_INVALID_SHAPE = 'SKILL_EXPORT_INVALID_SHAPE';
const SKILL_EXPORT_NOT_FOUND = 'SKILL_EXPORT_NOT_FOUND';
const SKILL_EXPORT_SOURCE_UNSUPPORTED = 'SKILL_EXPORT_SOURCE_UNSUPPORTED';
const SKILL_EXPORT_UNSAFE_TARGET = 'SKILL_EXPORT_UNSAFE_TARGET';

interface SkillExportMeta {
  /** skill 目录名（装回后 installService 记录的 skill 名） */
  name: string;
  /** 来自 SKILL.md frontmatter metadata.version，缺省省略 */
  version?: string;
  /** sha256(payload zip)，不含 _meta.json */
  contentHash: string;
}

export interface SkillExportPayload {
  /** discovery 视角的 skill 名（frontmatter name） */
  skillName: string;
  /** skill 目录名 = 装回后的 installed skill 名 */
  skillDirName: string;
  /** 建议保存文件名 */
  fileName: string;
  /** sha256(payload zip) */
  contentHash: string;
  /** 最终导出包（skill 内容 + 根部 _meta.json） */
  archive: Buffer;
}

export interface SkillExportOptions {
  /** 写入用户选择的目标路径时返回 savedPath；缺省只返回 Buffer */
  targetPath?: string;
}

// ----------------------------------------------------------------------------
// Entry-name 安全门（导出侧与 extractZipSafely 的 zip-slip 门同口径）
// ----------------------------------------------------------------------------

/**
 * 拒绝路径穿越文件名：`..` 段、绝对路径（POSIX / Windows 盘符）、反斜杠。
 * POSIX 文件名可以合法包含 `\`，打进 ZIP 后在 Windows 解压即穿越，导出侧必须
 * 提前拦下，否则导出的包自己的安装链（extractZipSafely）都装不回去。
 */
function assertSafeExportEntryName(entryName: string): void {
  const normalized = entryName.split(path.sep).join('/');
  if (
    !normalized
    || normalized.startsWith('/')
    || /^[a-zA-Z]:\//.test(normalized)
    || normalized.includes('\\')
    || normalized.split('/').includes('..')
  ) {
    throw new Error(`${SKILL_EXPORT_UNSAFE_ENTRY}: ${entryName}`);
  }
}

// ----------------------------------------------------------------------------
// 目录收集
// ----------------------------------------------------------------------------

/**
 * 递归收集 skill 目录下的文件（相对路径，POSIX 分隔，字典序）。
 * 拒绝符号链接（唯一能把打包范围逃出 skill 目录的路径穿越向量）与非常规文件。
 */
async function collectSkillFiles(skillDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(
          `${SKILL_EXPORT_UNSAFE_ENTRY}: symbolic link is not exportable: ${entry.name}`,
        );
      }
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath);
      } else if (entry.isFile()) {
        const relative = path.relative(skillDir, absPath).split(path.sep).join('/');
        assertSafeExportEntryName(relative);
        files.push(relative);
      } else {
        throw new Error(
          `${SKILL_EXPORT_UNSAFE_ENTRY}: unsupported file type: ${entry.name}`,
        );
      }
    }
  }

  await walk(skillDir);
  return files.sort();
}

function assertSkillShape(files: string[], skillDir: string): void {
  if (files.length === 0) {
    throw new Error(`${SKILL_EXPORT_INVALID_SHAPE}: skill directory is empty: ${skillDir}`);
  }
  const skillMdEntries = files.filter(
    (relative) => relative === 'SKILL.md' || relative.endsWith('/SKILL.md'),
  );
  if (skillMdEntries.length === 0) {
    throw new Error(`${SKILL_EXPORT_INVALID_SHAPE}: skill directory has no SKILL.md: ${skillDir}`);
  }
  if (skillMdEntries.length > 1) {
    throw new Error(
      `${SKILL_EXPORT_INVALID_SHAPE}: expected exactly one SKILL.md, found ${skillMdEntries.length}: ${skillMdEntries.join(', ')}`,
    );
  }
  if (!files.includes('SKILL.md')) {
    throw new Error(
      `${SKILL_EXPORT_INVALID_SHAPE}: SKILL.md must sit at the skill directory root, found ${skillMdEntries[0]}`,
    );
  }
}

// ----------------------------------------------------------------------------
// ZIP 构建
// ----------------------------------------------------------------------------

function addPayloadEntries(zip: JSZip, skillDirName: string, files: string[], contents: Map<string, Buffer>): void {
  for (const relative of files) {
    const entryName = `${skillDirName}/${relative}`;
    assertSafeExportEntryName(entryName);
    zip.file(entryName, contents.get(relative)!, { date: FIXED_ZIP_DATE });
  }
}

async function generateZip(zip: JSZip): Promise<Buffer> {
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * IPC 传入的落盘路径必须是绝对 .zip，且不得写入配置目录 / 跟随符号链接。
 * 保存对话框选中的路径满足这些约束；HTTP 乱传任意文件会被拒。
 */
async function writeExportArchive(targetPath: string, archive: Buffer): Promise<string> {
  if (!path.isAbsolute(targetPath)) {
    throw new Error(`${SKILL_EXPORT_UNSAFE_TARGET}: export path must be absolute`);
  }
  const resolved = path.resolve(targetPath);
  if (path.extname(resolved).toLowerCase() !== '.zip') {
    throw new Error(`${SKILL_EXPORT_UNSAFE_TARGET}: export path must end with .zip`);
  }
  const configDir = path.resolve(getUserConfigDir());
  if (isPathInside(configDir, resolved)) {
    throw new Error(`${SKILL_EXPORT_UNSAFE_TARGET}: refusing to write inside config dir`);
  }
  const parent = path.dirname(resolved);
  const parentStat = await fs.lstat(parent).catch(() => null);
  if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`${SKILL_EXPORT_UNSAFE_TARGET}: export parent is not a real directory`);
  }
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
  const handle = await fs.open(resolved, flags, 0o644);
  try {
    await handle.writeFile(archive);
  } finally {
    await handle.close();
  }
  return resolved;
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * 把一个 skill 目录打成导出包（不查 discovery，装回复核也用它对安装后的目录重算 hash）。
 */
async function packageSkillDirectory(
  skillDir: string,
  options: { skillName?: string; version?: string } = {},
): Promise<SkillExportPayload> {
  const resolvedDir = path.resolve(skillDir);
  const stat = await fs.stat(resolvedDir).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`${SKILL_EXPORT_INVALID_SHAPE}: skill directory not found: ${resolvedDir}`);
  }

  const files = await collectSkillFiles(resolvedDir);
  assertSkillShape(files, resolvedDir);

  const skillDirName = path.basename(resolvedDir);
  const contents = new Map<string, Buffer>();
  for (const relative of files) {
    contents.set(relative, await fs.readFile(path.join(resolvedDir, relative)));
  }

  // payload zip：只含 skill 内容，是 contentHash 的覆盖对象
  const payloadZip = new JSZip();
  addPayloadEntries(payloadZip, skillDirName, files, contents);
  const payloadArchive = await generateZip(payloadZip);
  const contentHash = getArchiveSha256(payloadArchive);

  // 最终包：payload + 根部 _meta.json（不入 hash，避免自指）
  const meta: SkillExportMeta = {
    name: skillDirName,
    ...(options.version ? { version: options.version } : {}),
    contentHash,
  };
  const finalZip = new JSZip();
  addPayloadEntries(finalZip, skillDirName, files, contents);
  finalZip.file('_meta.json', `${JSON.stringify(meta, null, 2)}\n`, { date: FIXED_ZIP_DATE });
  const archive = await generateZip(finalZip);

  return {
    skillName: options.skillName ?? skillDirName,
    skillDirName,
    fileName: `${skillDirName}.skill.zip`,
    contentHash,
    archive,
  };
}

/**
 * 按已安装 skill 名导出（user/project scope，按现有 discovery 解析目录）。
 * 只生产 ZIP：装回仍走 installService，本服务不开安装链。
 */
export async function exportInstalledSkill(
  skillName: string,
  options: SkillExportOptions = {},
): Promise<SkillExportPayload & { savedPath?: string }> {
  const discovery = getSkillDiscoveryService();
  const skill = discovery.getAllSkills().find((candidate: ParsedSkill) => candidate.name === skillName);
  if (!skill) {
    throw new Error(`${SKILL_EXPORT_NOT_FOUND}: ${skillName}`);
  }
  if (!EXPORTABLE_SKILL_SOURCES.has(skill.source)) {
    throw new Error(
      `${SKILL_EXPORT_SOURCE_UNSUPPORTED}: '${skillName}' (source: ${skill.source}); only user or project skills can be exported`,
    );
  }
  if (!skill.basePath) {
    throw new Error(`${SKILL_EXPORT_INVALID_SHAPE}: skill has no local directory: ${skillName}`);
  }

  const payload = await packageSkillDirectory(skill.basePath, {
    skillName: skill.name,
    version: skill.metadata?.version,
  });

  if (options.targetPath) {
    const savedPath = await writeExportArchive(options.targetPath, payload.archive);
    logger.info('Skill exported to file', {
      skillName: payload.skillName,
      skillDirName: payload.skillDirName,
      contentHash: payload.contentHash,
      savedPath,
    });
    return { ...payload, savedPath };
  }

  logger.info('Skill exported', {
    skillName: payload.skillName,
    skillDirName: payload.skillDirName,
    contentHash: payload.contentHash,
    bytes: payload.archive.byteLength,
  });
  return payload;
}
