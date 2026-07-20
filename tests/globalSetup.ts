import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 测试里有上百处 mkdtemp(path.join(os.tmpdir(), ...))，绝大多数跑完不删目录。
// 把 TMPDIR 指到单个 run 级根目录，跑完整根删掉即可回收全部残留，
// 且不会误删并行 worktree 正在跑的那一份。
export default function setup() {
  const runRoot = mkdtempSync(path.join(os.tmpdir(), 'code-agent-vitest-run-'));
  process.env.TMPDIR = runRoot;

  return () => {
    rmSync(runRoot, { recursive: true, force: true });
  };
}
