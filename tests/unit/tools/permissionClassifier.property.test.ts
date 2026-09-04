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
});
