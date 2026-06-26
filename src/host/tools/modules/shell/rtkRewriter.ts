// ============================================================================
// rtk Rewriter — Bash 命令 token 优化 (B 方案)
//
// 上游: rtk-ai/rtk (MIT), bundle 内置 (scripts/rtk), 见 [[project_neo_rtk_bundling]]
//
// 设计原则:
// - 默认关 (env CODE_AGENT_BASH_RTK_REWRITE_ENABLED=1 才开启)
// - fail-closed: 任何异常 (binary 缺失/超时/退出码非零/输出为空) 都退回原命令
// - 只对 foreground 路径生效, PTY/background 不动 (保持原行为)
// - policy 检查在 rewrite 之前, 避免 `rm -rf /` 被绕开
// ============================================================================
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { BASH } from '../../../../shared/constants';

const BINARY_NAME = 'rtk';

let cachedBinaryPath: string | null = null;

/**
 * 解析 rtk binary 路径 — dev 跑 scripts/rtk, Tauri 打包跑 Resources/.../scripts/rtk
 * 探针顺序跟 ocrSearch.ts 同模式
 */
function findRtkBinary(): string | null {
  if (cachedBinaryPath && fs.existsSync(cachedBinaryPath)) return cachedBinaryPath;

  const candidates: string[] = [];
  // dev: scripts/ 目录
  candidates.push(path.join(__dirname, '..', '..', '..', '..', '..', 'scripts', BINARY_NAME));
  candidates.push(path.join(__dirname, '..', '..', '..', '..', 'scripts', BINARY_NAME));
  candidates.push(path.join(__dirname, '..', '..', '..', 'scripts', BINARY_NAME));
  // Tauri 打包: Resources/_up_/scripts/ 或 Resources/scripts/
  candidates.push(path.join(__dirname, '..', '..', 'scripts', BINARY_NAME));
  candidates.push(path.join(__dirname, '..', 'scripts', BINARY_NAME));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        cachedBinaryPath = candidate;
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function isRtkRewriteEnabled(): boolean {
  const v = process.env.CODE_AGENT_BASH_RTK_REWRITE_ENABLED;
  return v === '1' || v === 'true';
}

/**
 * 把 bash command 喂给 `rtk rewrite`, 返回 rtk 改写后的命令。
 * 任何失败都退回原命令 (fail-closed), 永不抛错。
 */
export async function rewriteBashCommand(command: string): Promise<string> {
  if (!isRtkRewriteEnabled()) return command;
  if (!command.trim()) return command;

  const binary = findRtkBinary();
  if (!binary) return command;

  return new Promise<string>((resolve) => {
    execFile(
      binary,
      ['rewrite', command],
      { timeout: BASH.RTK_REWRITE_TIMEOUT, encoding: 'utf-8', maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(command);
          return;
        }
        const rewritten = stdout.trim();
        if (!rewritten) {
          resolve(command);
          return;
        }
        resolve(rewritten);
      },
    );
  });
}
