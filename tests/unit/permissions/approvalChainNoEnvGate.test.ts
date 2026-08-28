import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const orchestratorPermissionsPath = path.join(
  repoRoot,
  'src/host/agent/orchestratorPermissions.ts',
);
const permissionsRoot = path.join(repoRoot, 'src/host/permissions');

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * H2 定点门：生产审批链不许有环境变量门控的测试专用分支。
 * 防的是换名后重塞同构后门，不是 AUTO_TEST 或任何一个具体变量名。
 *
 * requestPermission 判据：从 `async requestPermission(` 签名开始，找到签名后的首个
 * `{`，再以词法括号配平扫描；注释、单双引号和模板字符串里的括号不计入深度，深度
 * 回到 0 的 `}` 即该方法结束。定位失败直接令测试失败，不能静默缩小检查范围。
 */
function extractRequestPermissionMethod(source: string): { source: string; start: number } {
  const signature = /\basync\s+requestPermission\s*\(/g.exec(source);
  if (!signature) throw new Error('找不到 async requestPermission( 方法签名');

  const openingBrace = source.indexOf('{', signature.index + signature[0].length);
  if (openingBrace === -1) throw new Error('找不到 requestPermission() 方法体起始括号');

  let depth = 0;
  let state: 'code' | 'single' | 'double' | 'template' | 'line-comment' | 'block-comment' = 'code';
  let escaped = false;

  for (let index = openingBrace; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (state === 'line-comment') {
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        state = 'code';
        index += 1;
      }
      continue;
    }
    if (state !== 'code') {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (
        (state === 'single' && char === "'")
        || (state === 'double' && char === '"')
        || (state === 'template' && char === '`')
      ) {
        state = 'code';
      }
      continue;
    }

    if (char === '/' && next === '/') {
      state = 'line-comment';
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
      continue;
    }
    if (char === "'") {
      state = 'single';
      continue;
    }
    if (char === '"') {
      state = 'double';
      continue;
    }
    if (char === '`') {
      state = 'template';
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          source: source.slice(signature.index, index + 1),
          start: signature.index,
        };
      }
    }
  }

  throw new Error('requestPermission() 方法体括号未配平');
}

function listTypeScriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(absolutePath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [absolutePath] : [];
  });
}

function failWithMatches(
  rule: string,
  matches: Array<{ file: string; line: number; text: string }>,
): void {
  if (matches.length === 0) return;
  const locations = matches
    .map(({ file, line, text }) => `${path.relative(repoRoot, file)}:${line}: ${text.trim()}`)
    .join('\n');
  throw new Error(`${rule}\n${locations}`);
}

describe('审批链零环境变量门控不变量', () => {
  it('requestPermission() 方法体内零 process.env 引用', () => {
    const fileSource = readFileSync(orchestratorPermissionsPath, 'utf8');
    const method = extractRequestPermissionMethod(fileSource);
    const matches = [...method.source.matchAll(/process\.env/g)].map((match) => ({
      file: orchestratorPermissionsPath,
      line: lineNumberAt(fileSource, method.start + (match.index ?? 0)),
      text: fileSource.split('\n')[lineNumberAt(fileSource, method.start + (match.index ?? 0)) - 1] ?? '',
    }));

    failWithMatches('H2：requestPermission() 不得读取 process.env', matches);
    expect(matches).toEqual([]);
  });

  it('生产审批链不存在“读 env 后 200 字符内直接 approved: true”形态', () => {
    const files = [orchestratorPermissionsPath, ...listTypeScriptFiles(permissionsRoot)];
    const envAutoApprovePattern = /process\.env\.[A-Z_]+\s*===?\s*['"][^'"]+['"][\s\S]{0,200}?approved:\s*true/g;
    const matches = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(envAutoApprovePattern)].map((match) => {
        const index = match.index ?? 0;
        const line = lineNumberAt(source, index);
        return { file, line, text: source.split('\n')[line - 1] ?? '' };
      });
    });

    failWithMatches('H2：生产审批链发现环境变量直接放行分支', matches);
    expect(matches).toEqual([]);
  });
});
