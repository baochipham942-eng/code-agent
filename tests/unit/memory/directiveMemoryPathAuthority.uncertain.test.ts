// ============================================================================
// RQ-066 / N-DIRECTIVEGATE-UNCERTAIN-BASH：uncertain 不再是「确定要写记忆目录」
//
// 原病：assessDirectiveMemoryWrite 把 resolveToolWriteTargets 的 uncertain 结果
// （变量/反引号重定向、解析失败兜底等「解析不出写目标」的形态）一律并进 targets，
// 于是根本没碰记忆目录的命令也 requiresConfirmation；headless（CLI run / 无界面 web）
// 下确认门 fail-fast，整条 Bash 以 DIRECTIVE_MEMORY_HEADLESS_NO_UI_ERROR 劫杀——
// 模型根本没要写记忆。eval L3 有 5 题 7 次调用被此病劫持。
//
// 根治：uncertain 只在条目本身带着指向记忆目录的证据（原始词含记忆目录路径或别名）
// 时才保持 fail-closed；无证据的 uncertain 不触发 directive 记忆门（command safety /
// ownership / 沙箱等其它安全门照常，不在本文件管辖面）。
//
// 本门守两组断言：
//   A. 复现：不确定形态但不触碰记忆目录 → requiresConfirmation === false；
//   B. 红线：确定写记忆目录、或不确定但带着记忆目录证据 → requiresConfirmation === true。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

// 目录名刻意用真实的 `.code-agent/memory` 尾巴：uncertain 证据判定走别名
// （basename(dirname)/basename），假尾巴测不到真实口径。
const MEMORY_DIR = path.join(os.tmpdir(), 'neo-uncertain-gate', '.code-agent', 'memory');

vi.mock('../../../src/host/lightMemory/indexLoader', () => ({
  getMemoryDir: () => MEMORY_DIR,
}));

import type { ToolDefinition } from '../../../src/shared/contract';
import { assessDirectiveMemoryWrite } from '../../../src/host/memory/directiveMemoryPathAuthority';
import { resolveCanonicalRunPath } from '../../../src/host/runtime/runContext';

const BASH_DEFINITION = {
  name: 'Bash',
  description: 'execute shell',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string' }, working_directory: { type: 'string' } },
    required: ['command'],
  },
  requiresPermission: true,
  permissionLevel: 'execute',
  pathAuthority: [{ kind: 'shell', commandParameter: 'command' }],
} as unknown as ToolDefinition;

function assessBash(params: Record<string, unknown>) {
  return assessDirectiveMemoryWrite({
    definition: BASH_DEFINITION,
    params,
    workingDirectory: os.tmpdir(),
  });
}

describe('RQ-066 复现：uncertain 但不触碰记忆目录，不触发 directive 记忆门', () => {
  const noGateCases: Array<[string, Record<string, unknown>]> = [
    // 复合命令 &&：解析不出写目标 ≠ 要写记忆
    ['cd && rm 复合命令', { command: 'cd /tmp && rm -rf x' }],
    ['echo && echo 复合命令', { command: 'echo a && echo b' }],
    // 管道 + 带引号绝对路径：无写目标
    ['带引号绝对路径走管道', { command: 'cat "/tmp/foo bar.txt" | grep needle' }],
    // 确定的写目标在记忆目录外
    ['重定向到目录外', { command: 'echo done > /tmp/out.txt' }],
    ['复合命令带目录外重定向', { command: 'cd /tmp && echo done > out.txt' }],
    // uncertain-redirection：变量重定向目标，无记忆目录证据
    ['变量重定向目标（无证据）', { command: 'echo hi > "$OUT/file.txt"' }],
    // uncertain-command-analysis：动态替换解析失败 + 有重定向，但目标是目录外
    ['动态替换解析失败（无证据）', { command: 'echo "at $(date)" > /tmp/log.txt' }],
    // uncertain:<param>：空的路径形态参数，无目标更无证据
    ['空 working_directory 参数', { command: 'ls', working_directory: '' }],
  ];

  it.each(noGateCases)('%s → requiresConfirmation === false', (_label, params) => {
    const assessment = assessBash(params);
    expect(assessment.requiresConfirmation).toBe(false);
    expect(assessment.targets).toEqual([]);
  });
});

describe('红线：确定写记忆目录、或不确定但带记忆目录证据，仍触发记忆门', () => {
  it('确定重定向进记忆目录 → 要求确认且目标含该文件', () => {
    const assessment = assessBash({
      command: `echo pwned > ${path.join(MEMORY_DIR, 'foo.md')}`,
    });
    expect(assessment.requiresConfirmation).toBe(true);
    expect(assessment.targets).toContain(
      resolveCanonicalRunPath(path.join(MEMORY_DIR, 'foo.md')),
    );
  });

  it('确定追加进记忆目录 INDEX → 要求确认', () => {
    const assessment = assessBash({
      command: `printf entry >> ${path.join(MEMORY_DIR, 'INDEX.md')}`,
    });
    expect(assessment.requiresConfirmation).toBe(true);
  });

  it('字面值提及记忆目录（无重定向）→ 要求确认', () => {
    const assessment = assessBash({
      command: `cat ${path.join(MEMORY_DIR, 'foo.md')} && echo done`,
    });
    expect(assessment.requiresConfirmation).toBe(true);
  });

  it('uncertain 但原始词带记忆目录证据（变量文件名）→ fail-closed 要求确认', () => {
    // shellWordValue 解出 ~/.code-agent/memory/$NAME，含 $ 解析不出确定目标，
    // 但原始词本身指向记忆目录——这条证据不许丢。
    const assessment = assessBash({
      command: 'echo x > ~/.code-agent/memory/"$NAME".md',
    });
    expect(assessment.requiresConfirmation).toBe(true);
    expect(assessment.targets.some((target) => target.includes('.code-agent/memory'))).toBe(true);
  });
});
