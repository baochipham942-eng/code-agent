// ============================================================================
// Doctor Check - Hooks 配置语法
// 校验 global + project 的 hooks 配置文件能否正常解析。
// parseHooksConfig 已经做 try/catch 返回 []，本检查在解析后回报：
//   - 文件不存在 → skip
//   - 解析成功且有 hook 条目 → pass
//   - 文件存在但解析后是空（可能是结构错误） → warn / skip
//   - JSON 语法错误 → warn（带 reason）
// ============================================================================

import { promises as fs } from 'fs';
import { getHooksConfigPaths, parseHooksConfig } from '../../hooks/configParser';
import type { DoctorItem, DoctorStatus } from '../types';

interface HookSourceCheckInput {
  source: 'global' | 'project';
  workingDirectory: string;
}

/** 返回 null 表示 JSON OK，否则返回错误描述 */
async function validateJsonSyntax(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    JSON.parse(content);
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return err instanceof Error ? err.message : String(err);
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function checkOneSource({ source, workingDirectory }: HookSourceCheckInput): Promise<DoctorItem> {
  const all = getHooksConfigPaths(workingDirectory);
  const configPaths = all[source];

  const existed: { path: string; type: 'hooks-json' | 'settings-json' }[] = [];
  for (const cp of configPaths) {
    if (await fileExists(cp.path)) {
      existed.push(cp);
    }
  }

  if (existed.length === 0) {
    return {
      category: 'hooks',
      name: `${source} hooks 配置`,
      status: 'skip',
      message: '未配置（不存在）',
    };
  }

  existed.sort((a, b) => {
    const pa = configPaths.find((cp) => cp.path === a.path)?.priority ?? 0;
    const pb = configPaths.find((cp) => cp.path === b.path)?.priority ?? 0;
    return pa - pb;
  });

  const target = existed[0];

  const syntaxErr = await validateJsonSyntax(target.path);
  if (syntaxErr) {
    return {
      category: 'hooks',
      name: `${source} hooks 配置`,
      status: 'warn',
      message: 'JSON 解析失败',
      details: `${target.path}\n${syntaxErr}`,
      suggestion: '检查 JSON 语法（引号、逗号、括号匹配）',
    };
  }

  try {
    const parsed = await parseHooksConfig(target.path, source, target.type);
    const status: DoctorStatus = parsed.length > 0 ? 'pass' : 'skip';
    return {
      category: 'hooks',
      name: `${source} hooks 配置`,
      status,
      message:
        parsed.length > 0
          ? `${parsed.length} 个 hook 已加载`
          : '文件可解析但无 hook',
      details: target.path,
    };
  } catch (err) {
    return {
      category: 'hooks',
      name: `${source} hooks 配置`,
      status: 'warn',
      message: '解析出错',
      details: `${target.path}\n${err instanceof Error ? err.message : String(err)}`,
      suggestion: '查看上面 details 中的解析错误',
    };
  }
}

export async function checkHooksConfig(workingDirectory: string): Promise<DoctorItem[]> {
  return Promise.all([
    checkOneSource({ source: 'global', workingDirectory }),
    checkOneSource({ source: 'project', workingDirectory }),
  ]);
}
