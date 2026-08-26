import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../../../src/shared/contract';
import { canonicalizeCommand } from '../../../src/host/security/canonicalizeCommand';
import { scanSkillContent } from '../../../src/host/security/skillContentGuard';
import { ConfirmationGate } from '../../../src/host/agent/confirmationGate';
import { matchDangerousBash } from '../../../src/host/planning/matchers';
import {
  isCommandBlocked,
  isDangerousCommand as isPresetDangerousCommand,
} from '../../../src/host/services/core/permissionPresets';
import { checkCommandPolicy } from '../../../src/host/tools/modules/shell/commandPolicy';
import { isDangerousCommand as isPermissionCardDangerousCommand } from '../../../src/host/tools/toolExecutorHelpers';
import { resolveToolWriteTargets } from '../../../src/host/tools/writeTargets';
import { resolveCanonicalRunPath } from '../../../src/host/runtime/runContext';

const SHELL_WRITE_TOOL: ToolDefinition = {
  name: 'CanonicalShellWrite',
  description: 'test fixture',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
  outputSchema: { type: 'string' },
  permissionLevel: 'write',
  requiresPermission: true,
  pathAuthority: [{ kind: 'shell', commandParameter: 'command' }],
};

describe('canonicalizeCommand 单一命令规范化管道', () => {
  it.each([
    ['引号拆词', 'r"m" -rf /'],
    ['ANSI-C 十六进制', "$'\\x72m' -rf /"],
    ['反斜杠续行', 'r\\\nm -rf /'],
  ])('%s 统一还原后命中硬阻断与 skill guard', (_label, command) => {
    expect(canonicalizeCommand(command)).toMatchObject({
      command: 'rm -rf /',
      parsingFailed: false,
    });
    expect(checkCommandPolicy(command)).toMatchObject({
      allowed: false,
      source: 'hard-block',
      canonicalCommand: 'rm -rf /',
    });
    expect(scanSkillContent(`\`\`\`bash\n${command}\n\`\`\``).verdict).toBe('block');
  });

  it('反引号命令替换在 policy 与 skill 入口都按不可静态解析处理', () => {
    const command = "r`printf ''`m -rf /";

    expect(canonicalizeCommand(command).parsingFailed).toBe(true);
    expect(checkCommandPolicy(command).parsingFailed).toBe(true);
    expect(scanSkillContent(`\`\`\`bash\n${command}\n\`\`\``).verdict).toBe('block');
  });

  it.each([
    ['引号拆词', 'r"m" -rf /'],
    ['ANSI-C 十六进制', "$'\\x72m' -rf /"],
    ['反斜杠续行', 'r\\\nm -rf /'],
  ])('%s 在全部 host 权限匹配入口保持相同危险结论', (_label, command) => {
    expect(isCommandBlocked(command, ['rm -rf /'])).toBe(true);
    expect(isPresetDangerousCommand(command)).toBe(true);
    expect(new ConfirmationGate().assessRiskLevel('Bash', { command })).toBe('high');
    expect(matchDangerousBash()({ toolName: 'Bash', toolParams: { command } })).toBe(true);
    expect(isPermissionCardDangerousCommand(command)).toBe(true);
  });

  it('无法解析的动态替换在权限匹配入口统一 fail-closed', () => {
    const command = "r`printf ''`m -rf /";

    expect(isPresetDangerousCommand(command)).toBe(true);
    expect(new ConfirmationGate().assessRiskLevel('Bash', { command })).toBe('high');
    expect(matchDangerousBash()({ toolName: 'Bash', toolParams: { command } })).toBe(true);
    expect(isPermissionCardDangerousCommand(command)).toBe(true);
  });

  it('writeTargets 对引号、ANSI-C 与续行路径得出同一目标', () => {
    const workingDirectory = '/tmp/canonical-write-targets';
    const commands = [
      'printf x > re"port".txt',
      "printf x > $'\\x72eport.txt'",
      'printf x > rep\\\nort.txt',
    ];

    for (const command of commands) {
      expect(resolveToolWriteTargets({
        definition: SHELL_WRITE_TOOL,
        params: { command },
        workingDirectory,
      })).toMatchObject({
        targets: [resolveCanonicalRunPath(path.join(workingDirectory, 'report.txt'))],
        uncertain: [],
      });
    }
  });

  it('writeTargets 把反引号替换保留为不确定目标', () => {
    const result = resolveToolWriteTargets({
      definition: SHELL_WRITE_TOOL,
      params: { command: 'printf x > re`printf p`ort.txt' },
      workingDirectory: '/tmp/canonical-write-targets',
    });

    expect(result.targets).toEqual([]);
    expect(result.uncertain).toEqual(expect.arrayContaining([
      expect.stringContaining('uncertain-command-analysis:'),
      expect.stringContaining('uncertain-redirection:'),
    ]));
  });

  it.each([
    ["printf 'unterminated", 'unclosed single quote'],
    ['printf trailing\\', 'trailing escape'],
  ])('无法拆词时返回稳定 canonical form 与失败原因: %s', (command, reason) => {
    expect(canonicalizeCommand(command)).toMatchObject({
      parsingFailed: true,
      failureReason: reason,
    });
  });
});
