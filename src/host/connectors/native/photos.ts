// ============================================================================
// Native Photos Connector - macOS Photos.app via AppleScript
// ============================================================================
//
// 提供编程接口给 photo-archive skill / photoLibraryTagger service：
//   - list_albums: 枚举所有相册名 + 照片数量
//   - list_photos: 给定相册返回 media item 元数据（uuid/filename/date）
//   - export_photos: 导出相册或指定 uuid 到临时目录（供 vision-tagger 处理）
//
// Photos.app 不允许直接读取 library 内文件路径，必须通过 AppleScript export。
// ============================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Connector, ConnectorExecutionResult, ConnectorStatus } from '../base';
import { escapeAppleScriptString, runAppleScript } from './osascript';

type NativeReadiness = 'unchecked' | 'ready' | 'failed' | 'unavailable';

let photosReadiness: NativeReadiness = 'unchecked';

export function resetPhotosConnectorReadiness(): void {
  photosReadiness = 'unchecked';
}

function buildPhotosStatus(capabilities: string[]): ConnectorStatus {
  if (process.platform !== 'darwin') {
    return {
      connected: false,
      readiness: 'unavailable',
      detail: 'Photos 连接器仅支持 macOS',
      capabilities,
    };
  }
  return {
    connected: photosReadiness === 'ready',
    readiness: photosReadiness,
    detail: photosReadiness === 'ready'
      ? 'Photos.app 自动化权限已就绪'
      : photosReadiness === 'failed'
      ? 'Photos.app 自动化权限被拒绝（首次访问需用户在系统偏好→隐私与安全性→自动化中授权）'
      : photosReadiness === 'unavailable'
      ? 'Photos.app 不可访问'
      : '尚未检查',
    capabilities,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// AppleScript 不擅长返回结构化数据，约定用 "|" 分隔字段、"\n" 分隔行。
const FIELD_SEPARATOR = ''; // unit separator，避免跟相册名里的 | 冲突
const RECORD_SEPARATOR = '';

interface AlbumInfo {
  name: string;
  count: number;
}

interface MediaItemInfo {
  uuid: string;
  filename: string;
  date: number | null; // ms timestamp
  width: number | null;
  height: number | null;
}

async function probePhotosAccess(): Promise<void> {
  // 简单的 access probe：调一次 count of every album。
  // 如果用户没授权，AppleScript 会抛错被 catch 标记 failed。
  try {
    const output = await runAppleScript([
      'tell application "Photos"',
      '  return count of every album',
      'end tell',
    ]);
    const n = parseInt(output.trim(), 10);
    if (Number.isFinite(n)) {
      photosReadiness = 'ready';
    } else {
      photosReadiness = 'failed';
    }
  } catch (err) {
    const msg = errorMessage(err);
    photosReadiness = msg.includes('not authorized') || msg.includes('-1743') ? 'failed' : 'unavailable';
    throw err;
  }
}

async function listAlbums(): Promise<AlbumInfo[]> {
  const lines = [
    'tell application "Photos"',
    '  set out to ""',
    '  repeat with anAlbum in every album',
    '    set albumName to name of anAlbum',
    '    set itemCount to count of media items of anAlbum',
    `    set out to out & albumName & "${FIELD_SEPARATOR}" & itemCount & "${RECORD_SEPARATOR}"`,
    '  end repeat',
    '  return out',
    'end tell',
  ];
  const output = await runAppleScript(lines);
  const albums: AlbumInfo[] = [];
  for (const record of output.split(RECORD_SEPARATOR)) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(FIELD_SEPARATOR);
    const name = (parts[0] ?? '').trim();
    const count = parseInt((parts[1] ?? '0').trim(), 10);
    if (!name) continue;
    albums.push({ name, count: Number.isFinite(count) ? count : 0 });
  }
  return albums;
}

async function listPhotosInAlbum(payload: Record<string, unknown>): Promise<MediaItemInfo[]> {
  const album = typeof payload.album === 'string' ? payload.album.trim() : '';
  if (!album) {
    throw new Error('list_photos 必须提供 album 字段（相册名）');
  }
  const limitRaw = payload.limit;
  const limit = typeof limitRaw === 'number' && limitRaw > 0 ? Math.floor(limitRaw) : 200;

  const lines = [
    'tell application "Photos"',
    `  set theAlbum to first album whose name is "${escapeAppleScriptString(album)}"`,
    '  set theItems to media items of theAlbum',
    '  set total to count of theItems',
    `  set maxItems to ${limit}`,
    '  if total < maxItems then set maxItems to total',
    '  set out to ""',
    '  repeat with i from 1 to maxItems',
    '    set anItem to item i of theItems',
    '    set itemId to id of anItem',
    '    try',
    '      set itemName to filename of anItem',
    '    on error',
    '      set itemName to ""',
    '    end try',
    '    try',
    '      set itemDate to date of anItem',
    '      set dateString to (year of itemDate as string) & "-" & (month of itemDate as integer as string) & "-" & (day of itemDate as string) & " " & (time string of itemDate)',
    '    on error',
    '      set dateString to ""',
    '    end try',
    '    try',
    '      set itemW to width of anItem',
    '      set itemH to height of anItem',
    '    on error',
    '      set itemW to ""',
    '      set itemH to ""',
    '    end try',
    `    set out to out & itemId & "${FIELD_SEPARATOR}" & itemName & "${FIELD_SEPARATOR}" & dateString & "${FIELD_SEPARATOR}" & itemW & "${FIELD_SEPARATOR}" & itemH & "${RECORD_SEPARATOR}"`,
    '  end repeat',
    '  return out',
    'end tell',
  ];
  const output = await runAppleScript(lines);
  const items: MediaItemInfo[] = [];
  for (const record of output.split(RECORD_SEPARATOR)) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(FIELD_SEPARATOR);
    const uuid = (parts[0] ?? '').trim();
    if (!uuid) continue;
    const filename = (parts[1] ?? '').trim();
    const dateStr = (parts[2] ?? '').trim();
    const widthStr = (parts[3] ?? '').trim();
    const heightStr = (parts[4] ?? '').trim();
    items.push({
      uuid,
      filename,
      date: dateStr ? new Date(dateStr).getTime() || null : null,
      width: widthStr ? parseInt(widthStr, 10) : null,
      height: heightStr ? parseInt(heightStr, 10) : null,
    });
  }
  return items;
}

interface ExportResult {
  exportDir: string;
  count: number;
  files: string[];
}

async function exportPhotos(payload: Record<string, unknown>): Promise<ExportResult> {
  const album = typeof payload.album === 'string' ? payload.album.trim() : '';
  const uuidsRaw = payload.uuids;
  const uuids = Array.isArray(uuidsRaw)
    ? uuidsRaw.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];

  if (!album && uuids.length === 0) {
    throw new Error('export_photos 必须提供 album 或 uuids 之一');
  }

  // 创建临时目录
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-archive-'));

  const useOriginals = payload.useOriginals !== false;
  const originalsFlag = useOriginals ? 'with using originals' : 'without using originals';
  const exportDirEscaped = escapeAppleScriptString(exportDir);

  let scriptLines: string[];
  if (uuids.length > 0) {
    // 按 uuid 导出
    const idList = uuids.map((id) => `"${escapeAppleScriptString(id)}"`).join(', ');
    scriptLines = [
      'tell application "Photos"',
      `  set targetItems to {}`,
      `  set candidateIds to {${idList}}`,
      '  repeat with anId in candidateIds',
      '    try',
      '      set end of targetItems to media item id anId',
      '    end try',
      '  end repeat',
      `  export targetItems to (POSIX file "${exportDirEscaped}") ${originalsFlag}`,
      '  return count of targetItems',
      'end tell',
    ];
  } else {
    scriptLines = [
      'tell application "Photos"',
      `  set theAlbum to first album whose name is "${escapeAppleScriptString(album)}"`,
      '  set targetItems to media items of theAlbum',
      `  export targetItems to (POSIX file "${exportDirEscaped}") ${originalsFlag}`,
      '  return count of targetItems',
      'end tell',
    ];
  }

  const output = await runAppleScript(scriptLines);
  const reported = parseInt(output.trim(), 10);

  // 读 export 目录列文件（递归）
  const files: string[] = [];
  const entries = fs.readdirSync(exportDir, { withFileTypes: true, recursive: true });
  for (const entry of entries as unknown as Array<{ name: string; isFile: () => boolean; parentPath?: string }>) {
    if (entry.isFile?.()) {
      const parent = (entry as { parentPath?: string }).parentPath ?? exportDir;
      files.push(path.join(parent, entry.name));
    }
  }
  return {
    exportDir,
    count: Number.isFinite(reported) ? reported : files.length,
    files,
  };
}

export const photosConnector: Connector = {
  id: 'photos',
  label: 'Photos',
  capabilities: [
    'get_status',
    'probe_access',
    'repair_permissions',
    'list_albums',
    'list_photos',
    'export_photos',
  ],
  getCachedStatus(): ConnectorStatus {
    return buildPhotosStatus(this.capabilities);
  },
  async getStatus(): Promise<ConnectorStatus> {
    return buildPhotosStatus(this.capabilities);
  },
  async execute(action: string, payload: Record<string, unknown>): Promise<ConnectorExecutionResult> {
    switch (action) {
      case 'get_status':
        return { data: await this.getStatus() };
      case 'probe_access': {
        try {
          await probePhotosAccess();
        } catch (err) {
          return {
            data: await this.getStatus(),
            summary: `Photos 自动化权限检查失败：${errorMessage(err)}`,
          };
        }
        return {
          data: await this.getStatus(),
          summary: 'Photos 自动化权限可用',
        };
      }
      case 'repair_permissions': {
        resetPhotosConnectorReadiness();
        try {
          await probePhotosAccess();
          return { data: await this.getStatus(), summary: 'Photos 权限修复检查通过' };
        } catch (err) {
          return {
            data: await this.getStatus(),
            summary: `Photos 权限修复失败：${errorMessage(err)}`,
          };
        }
      }
      case 'disconnect':
      case 'remove':
        resetPhotosConnectorReadiness();
        return {
          data: await this.getStatus(),
          summary: action === 'disconnect' ? 'Photos connector 已断开。' : 'Photos connector 已移除。',
        };
      case 'list_albums': {
        const albums = await listAlbums();
        return {
          data: albums,
          summary: `Photos 共 ${albums.length} 个相册`,
        };
      }
      case 'list_photos': {
        const photos = await listPhotosInAlbum(payload);
        return {
          data: photos,
          summary: `相册 "${payload.album}" 返回 ${photos.length} 张照片元数据`,
        };
      }
      case 'export_photos': {
        const result = await exportPhotos(payload);
        return {
          data: result,
          summary: `导出 ${result.count} 张照片到 ${result.exportDir}`,
        };
      }
      default:
        throw new Error(`未知 action: ${action}`);
    }
  },
};
