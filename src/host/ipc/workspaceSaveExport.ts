// ============================================================================
// 会话导出落盘 - 主进程直写「下载」文件夹
// ============================================================================
// 不走 webview 另存为对话框：打包态 WKWebView 里那条链路（remote IPC 注入 +
// dialog 权限）失败是静默的（2026-06-10 Intel 同事实测点击无反应）。
// 重名自动 -N 后缀；fileName 去路径分隔符防目录穿越。

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export async function handleSaveTextToDownloads(
  payload: { fileName: string; content: string }
): Promise<{ filePath: string }> {
  const safeName = payload.fileName.replace(/[/\\]/g, '_') || 'export.txt';
  const dir = path.join(os.homedir(), 'Downloads');
  await fs.mkdir(dir, { recursive: true });
  const ext = path.extname(safeName);
  const stem = ext ? safeName.slice(0, -ext.length) : safeName;
  let candidate = path.join(dir, safeName);
  for (let i = 1; i < 100; i += 1) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${stem}-${i}${ext}`);
    } catch {
      break;
    }
  }
  await fs.writeFile(candidate, payload.content, 'utf-8');
  return { filePath: candidate };
}

// 二进制（PDF / 图片等）落「下载」文件夹：与 text 版同源（去路径分隔符防穿越、
// 重名 -N 后缀），但 base64 解码成 Buffer 写盘——绝不带 'utf-8' 编码（会损坏二进制）。
export async function handleSaveBinaryToDownloads(
  payload: { fileName: string; base64: string }
): Promise<{ filePath: string }> {
  const safeName = payload.fileName.replace(/[/\\]/g, '_') || 'export.bin';
  const dir = path.join(os.homedir(), 'Downloads');
  await fs.mkdir(dir, { recursive: true });
  const ext = path.extname(safeName);
  const stem = ext ? safeName.slice(0, -ext.length) : safeName;
  let candidate = path.join(dir, safeName);
  for (let i = 1; i < 100; i += 1) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${stem}-${i}${ext}`);
    } catch {
      break;
    }
  }
  await fs.writeFile(candidate, Buffer.from(payload.base64, 'base64'));
  return { filePath: candidate };
}
