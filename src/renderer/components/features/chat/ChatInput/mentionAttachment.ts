// ============================================================================
// mentionAttachment - @ 面板选中工作区文件 → 附件（文件 chip 的数据载体）
// ============================================================================
//
// @ 文件 chip 内联进文字流后，正文不再携带 `@path` 文本，文件引用改走附件管线
// （与拖放/上传同一 store，发送时随消息）。文本类文件读出内容内联（上限
// MAX_MENTION_INLINE_CHARS，防 package-lock 这类大文件撑爆上下文）；二进制类别
// （图片/音视频/PDF/Excel/PPT/压缩包）只带路径，与「PDF 大文件只传路径」同款先例。

import type { AttachmentCategory, MessageAttachment } from '@shared/contract';
import {
  CODE_EXTENSIONS,
  DATA_EXTENSIONS,
  EXCEL_EXTENSIONS,
  PRESENTATION_EXTENSIONS,
  ARCHIVE_EXTENSIONS,
  STYLE_EXTENSIONS,
  TEXT_EXTENSIONS,
  generateAttachmentId,
} from './utils';
import { readWorkspaceFile } from '../../../design/designFiles';

/** 文本类文件内联上限（字符数），超出截断 */
const MAX_MENTION_INLINE_CHARS = 200_000;

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico'];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.webm'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi'];

/** 按文件名推导附件类别（@ 面板没有浏览器 File 对象，只有路径）。 */
export function getFileCategoryByName(name: string): { category: AttachmentCategory; language?: string } {
  const ext = `.${name.split('.').pop()?.toLowerCase() ?? ''}`;
  if (CODE_EXTENSIONS[ext]) return { category: 'code', language: CODE_EXTENSIONS[ext] };
  if (STYLE_EXTENSIONS[ext]) return { category: 'code', language: STYLE_EXTENSIONS[ext] };
  if (DATA_EXTENSIONS.includes(ext)) return { category: 'data' };
  if (TEXT_EXTENSIONS.includes(ext)) return { category: 'text' };
  if (ext === '.html' || ext === '.htm') return { category: 'html', language: 'html' };
  if (ext === '.pdf') return { category: 'pdf' };
  if (EXCEL_EXTENSIONS.includes(ext)) return { category: 'excel' };
  if (PRESENTATION_EXTENSIONS.includes(ext)) return { category: 'presentation' };
  if (ARCHIVE_EXTENSIONS.includes(ext)) return { category: 'archive' };
  if (IMAGE_EXTENSIONS.includes(ext)) return { category: 'image' };
  if (AUDIO_EXTENSIONS.includes(ext)) return { category: 'audio' };
  if (VIDEO_EXTENSIONS.includes(ext)) return { category: 'video' };
  if (ext === '.docx' || ext === '.doc') return { category: 'document' };
  return { category: 'other' };
}

/** 文本类（可安全内联内容）的类别；其余只带路径。 */
function isTextLikeCategory(category: AttachmentCategory): boolean {
  return category === 'code' || category === 'data' || category === 'text' || category === 'html' || category === 'other';
}

export function resolveMentionAbsolutePath(path: string, workingDirectory: string | null): string {
  if (path.startsWith('/')) return path;
  const clean = path.replace(/^\.\//, '');
  if (!workingDirectory) return clean;
  return `${workingDirectory.replace(/\/+$/, '')}/${clean}`;
}

export interface BuildMentionAttachmentInput {
  /** @ 面板给出的路径（工作区相对或绝对） */
  path: string;
  /** 文件名（面板行展示名） */
  name: string;
  workingDirectory: string | null;
}

export async function buildMentionAttachment(input: BuildMentionAttachmentInput): Promise<MessageAttachment> {
  const absolutePath = resolveMentionAbsolutePath(input.path, input.workingDirectory);
  const { category, language } = getFileCategoryByName(input.name);

  let data = '';
  if (isTextLikeCategory(category)) {
    const content = await readWorkspaceFile(absolutePath);
    if (content !== null) {
      data = content.length > MAX_MENTION_INLINE_CHARS
        ? `${content.slice(0, MAX_MENTION_INLINE_CHARS)}\n…（内容过长已截断）`
        : content;
    }
  }

  return {
    id: generateAttachmentId(),
    type: 'file',
    category,
    name: input.path,
    size: data.length,
    mimeType: 'text/plain',
    data,
    path: absolutePath,
    ...(language ? { language } : {}),
  };
}
