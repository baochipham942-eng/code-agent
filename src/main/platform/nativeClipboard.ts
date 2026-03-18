// ============================================================================
// Platform: Native Clipboard - 替代 Electron clipboard/nativeImage 模块
// ============================================================================

import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

export function readText(): string {
  try {
    if (process.platform === 'darwin') {
      return execSync('pbpaste', { encoding: 'utf-8' });
    }
    if (process.platform === 'linux') {
      return execSync('xclip -selection clipboard -o', { encoding: 'utf-8' });
    }
    // Windows
    return execSync('powershell -command Get-Clipboard', { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

export function writeText(text: string): void {
  try {
    if (process.platform === 'darwin') {
      execSync('pbcopy', { input: text });
    } else if (process.platform === 'linux') {
      execSync('xclip -selection clipboard', { input: text });
    } else {
      execSync(`powershell -command "Set-Clipboard -Value '${text.replace(/'/g, "''")}'"`);
    }
  } catch {
    // Silently fail if clipboard not available
  }
}

const emptyImage = {
  toPNG: () => Buffer.alloc(0),
  toJPEG: (_quality?: number) => Buffer.alloc(0),
  toBitmap: () => Buffer.alloc(0),
  toDataURL: () => '',
  getSize: () => ({ width: 0, height: 0 }),
  isEmpty: () => true,
  resize: (..._args: unknown[]) => emptyImage,
  crop: (..._args: unknown[]) => emptyImage,
  getBitmap: () => Buffer.alloc(0),
  getNativeHandle: () => Buffer.alloc(0),
  isTemplateImage: () => false,
  setTemplateImage: (..._args: unknown[]) => {},
  addRepresentation: (..._args: unknown[]) => {},
  getAspectRatio: () => 1,
  getScaleFactors: () => [1],
  toRGBA: () => ({ data: Buffer.alloc(0), width: 0, height: 0 }),
};

export const nativeImage = {
  createEmpty: () => ({ ...emptyImage }),
  createFromPath: (..._args: unknown[]) => ({ ...emptyImage }),
  createFromBuffer: (..._args: unknown[]) => ({ ...emptyImage }),
  createFromDataURL: (..._args: unknown[]) => ({ ...emptyImage }),
  createThumbnailFromPath: async (..._args: unknown[]) => ({ ...emptyImage }),
};

export const clipboard = {
  readText,
  writeText,
  readHTML: () => '',
  writeHTML: (..._args: unknown[]) => {},
  readImage: () => nativeImage.createEmpty(),
  writeImage: (..._args: unknown[]) => {},
  readRTF: () => '',
  writeRTF: (..._args: unknown[]) => {},
  clear: () => {},
  availableFormats: () => [] as string[],
  has: (..._args: unknown[]) => false,
  read: (..._args: unknown[]) => '',
  readBookmark: () => ({ title: '', url: '' }),
  readFindText: () => '',
  writeFindText: (..._args: unknown[]) => {},
  writeBookmark: (..._args: unknown[]) => {},
};
