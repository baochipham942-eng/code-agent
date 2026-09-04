import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { canonicalizeCommand } from '../../../src/host/security/canonicalizeCommand';

const ASCII_WORD_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_'.split('');

function fullwidth(character: string): string {
  if (character === '_') return '＿';
  return String.fromCharCode(character.charCodeAt(0) + 0xfee0);
}

describe('canonicalizeCommand properties', () => {
  it('normalizes digits, case, fullwidth confusables, quotes and ANSI-C pieces into one word', () => {
    fc.assert(fc.property(
      fc.array(fc.tuple(
        fc.constantFrom(...ASCII_WORD_CHARACTERS),
        fc.constantFrom('plain', 'single', 'double', 'ansi', 'fullwidth'),
      ), { minLength: 1, maxLength: 20 }),
      (pieces) => {
        const expected = pieces.map(([character]) => character).join('');
        const command = pieces.map(([character, style]) => {
          if (style === 'single') return `'${character}'`;
          if (style === 'double') return `"${character}"`;
          if (style === 'ansi') {
            return `$'\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}'`;
          }
          if (style === 'fullwidth') return fullwidth(character);
          return character;
        }).join('');

        expect(canonicalizeCommand(command)).toMatchObject({
          command: expected,
          parsingFailed: false,
        });
      },
    ), { numRuns: 300 });
  });

  it('does not collapse Cyrillic lookalikes into ASCII executable names', () => {
    fc.assert(fc.property(
      fc.constantFrom('а', 'е', 'о', 'р', 'с', 'х'),
      (lookalike) => {
        const result = canonicalizeCommand(`r${lookalike}m -rf /`);
        expect(result.command).not.toBe('rm -rf /');
      },
    ));
  });
});
