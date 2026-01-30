import { mkdtemp, rm, cp, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const FIXTURES_DIR = join(import.meta.dirname, '../../fixtures');
const TEMP_PREFIX = 'claude-e2e-';

export interface TempProject {
  path: string;
  cleanup: () => Promise<void>;
  snapshot: () => Promise<Map<string, string>>;
}

export async function createTempProject(
  fixture?: string
): Promise<TempProject> {
  const tempDir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));

  // 初始化 git
  execFileSync('git', ['init', '-q'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });

  // 复制 fixture 模板
  if (fixture) {
    const fixturePath = join(FIXTURES_DIR, fixture);
    try {
      await cp(fixturePath, tempDir, { recursive: true });

      // 如果有 package.json，安装依赖
      try {
        await readFile(join(tempDir, 'package.json'));
        execFileSync('npm', ['install', '--silent'], { cwd: tempDir, stdio: 'pipe' });
      } catch {}
    } catch (err) {
      console.warn(`Fixture "${fixture}" not found, using empty project`);
    }
  }

  // 初始提交
  execFileSync('git', ['add', '-A'], { cwd: tempDir });
  execFileSync('git', ['commit', '-m', 'init', '--allow-empty', '-q'], { cwd: tempDir });

  return {
    path: tempDir,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
    snapshot: async () => {
      return await snapshotDirectory(tempDir);
    },
  };
}

async function snapshotDirectory(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  async function walk(currentDir: string, prefix = '') {
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relativePath = join(prefix, entry.name);

      // 跳过 node_modules 和 .git
      if (entry.name === 'node_modules' || entry.name === '.git') continue;

      if (entry.isDirectory()) {
        await walk(fullPath, relativePath);
      } else {
        try {
          const content = await readFile(fullPath, 'utf-8');
          files.set(relativePath, content);
        } catch {}
      }
    }
  }

  await walk(dir);
  return files;
}
