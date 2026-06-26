import { execFile } from 'child_process';
import { stat, unlink } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { backgroundCgEventSurface } from './backgroundCgEventSurface';

const execFileAsync = promisify(execFile);

async function hasNonEmptyFile(filepath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filepath);
    return fileStat.size > 0;
  } catch {
    return false;
  }
}

export async function captureComputerSurfaceScreenshot(): Promise<string> {
  const filepath = path.join(os.tmpdir(), `code-agent-computer-surface-${Date.now()}.png`);
  await execFileAsync('screencapture', ['-x', filepath]);
  return filepath;
}

export async function captureComputerSurfaceAppScreenshot(targetApp: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const windows = await backgroundCgEventSurface.listWindows({ targetApp, limit: 1 });
    const win = windows[0];
    if (!win?.bounds) return null;
    const { x, y, width, height } = win.bounds;
    if (width <= 0 || height <= 0) return null;
    const filepath = path.join(os.tmpdir(), `code-agent-computer-surface-app-${Date.now()}.png`);
    if (Number.isFinite(win.windowId)) {
      try {
        await execFileAsync('screencapture', ['-x', '-l', String(win.windowId), filepath]);
        if (await hasNonEmptyFile(filepath)) {
          return filepath;
        }
      } catch {
        await unlink(filepath).catch(() => undefined);
      }
    }

    await execFileAsync('screencapture', [
      '-x',
      `-R${Math.floor(x)},${Math.floor(y)},${Math.floor(width)},${Math.floor(height)}`,
      filepath,
    ]);
    if (await hasNonEmptyFile(filepath)) {
      return filepath;
    }
    await unlink(filepath).catch(() => undefined);
    return null;
  } catch {
    return null;
  }
}
