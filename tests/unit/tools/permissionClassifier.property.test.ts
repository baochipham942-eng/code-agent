import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { validateCommand } from '../../../src/host/security/commandSafety';

const ENV_NAME_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_'.split('');

describe('permission classifier regex properties', () => {
  it('detects sensitive environment names containing digits in either case', () => {
    fc.assert(fc.property(
      fc.array(fc.constantFrom(...ENV_NAME_CHARACTERS), { maxLength: 8 }),
      fc.constantFrom('KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'CREDENTIAL'),
      fc.array(fc.constantFrom(...ENV_NAME_CHARACTERS), { maxLength: 8 }),
      fc.boolean(),
      (prefix, marker, suffix, braces) => {
        const variable = `${prefix.join('')}${marker}${suffix.join('')}`;
        const spelling = braces ? `\${${variable}}` : `$${variable}`;
        expect(validateCommand(`printf '%s' ${spelling}`).securityFlags).toContain('env_access');
      },
    ), { numRuns: 300 });
  });

  it('keeps the Grok counterexample API2_TOKEN under the env-access guard', () => {
    expect(validateCommand('echo $API2_TOKEN').securityFlags).toContain('env_access');
  });

  // 任务书阶段 2：正则只看字面量，而 shell 有一堆写法拼出同一条命令。凡是 shell 会解析成同一
  // 个 program 的拼法，分类结果必须一致——存活的反例就是「正则不够用」的证据。
  const respell = (token: string, style: string): string => {
    switch (style) {
      case 'single': return `'${token}'`;
      case 'double': return `"${token}"`;
      case 'ansic': return `$'${[...token].map((c) => `\\x${c.charCodeAt(0).toString(16)}`).join('')}'`;
      case 'split': return `${token[0]}''${token.slice(1)}`;
      case 'mixed': return `'${token[0]}'"${token.slice(1)}"`;
      default: return token;
    }
  };

  it.each([
    'rm -rf /',
    'chmod -R 777 /etc',
    'git push --force origin main',
    'npm publish',
  ])('quote and ANSI-C spellings of the program classify identically: %s', (command) => {
    const [program, ...rest] = command.split(' ');
    const baseline = [...validateCommand(command).securityFlags].sort();
    fc.assert(fc.property(
      fc.constantFrom('single', 'double', 'ansic', 'split', 'mixed'),
      (style) => {
        const respelled = [respell(program, style), ...rest].join(' ');
        expect([...validateCommand(respelled).securityFlags].sort()).toEqual(baseline);
      },
    ), { numRuns: 60 });
  });

  it('quoted spellings of a sensitive env name stay under the env-access guard', () => {
    fc.assert(fc.property(
      fc.constantFrom('API_KEY', 'MY_SECRET', 'GH_TOKEN', 'DB_PASSWORD'),
      fc.constantFrom('single', 'double', 'split', 'mixed'),
      (variable, style) => {
        // `printf '%s' "$API_KEY"` and `printf '%s' $API_KEY` read the same variable.
        const spelled = style === 'double' ? `"$${variable}"` : `$${variable}`;
        expect(validateCommand(`printf '%s' ${spelled}`).securityFlags).toContain('env_access');
      },
    ), { numRuns: 60 });
  });
});
