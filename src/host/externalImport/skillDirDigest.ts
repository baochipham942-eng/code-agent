import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

async function collectFiles(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectFiles(root, full, out);
    else if (entry.isFile()) out.push(path.relative(root, full));
  }
}

/** 目录内容摘要：相对路径 + 文件字节，与遍历顺序无关。 */
export async function digestSkillDir(dir: string): Promise<string> {
  const files: string[] = [];
  await collectFiles(dir, dir, files);
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${file.split(path.sep).join('/')}\0`);
    hash.update(await fs.readFile(path.join(dir, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}
