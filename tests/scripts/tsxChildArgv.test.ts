import { describe, expect, it } from 'vitest';

import { assembleTsxChildArgv } from '../../scripts/acceptance/tsxChildArgv';

function flagValue(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value === undefined) throw new Error(`missing ${flag}`);
  return value;
}

describe('assembleTsxChildArgv', () => {
  it('turns D:\\a\\x into a file URL and leaves --require as a filesystem path', () => {
    const preflight = 'D:\\a\\x\\preflight.cjs';
    const entry = 'D:\\a\\x\\child.ts';
    const argv = assembleTsxChildArgv(
      { preflightPath: preflight, loaderPath: 'D:\\a\\x', childEntry: entry },
      ['prepare', 'scenario', 'D:\\a\\x\\data'],
      true,
    );
    const imported = flagValue(argv, '--import');
    expect(imported.startsWith('file:///')).toBe(true);
    expect(imported.includes('\\')).toBe(false);
    expect(imported).toBe('file:///D:/a/x');
    expect(flagValue(argv, '--require')).toBe(preflight);
    expect(argv).toEqual([
      '--require', preflight,
      '--import', 'file:///D:/a/x',
      entry,
      'prepare', 'scenario', 'D:\\a\\x\\data',
    ]);
  });

  it('turns the Windows tsx loader path into a file URL with no backslash', () => {
    const loader = 'D:\\a\\code-agent\\node_modules\\tsx\\dist\\loader.mjs';
    const argv = assembleTsxChildArgv(
      {
        preflightPath: 'D:\\a\\code-agent\\node_modules\\tsx\\dist\\preflight.cjs',
        loaderPath: loader,
        childEntry: 'D:\\a\\code-agent\\tests\\e2e\\fixtures\\durableRunProcessHost.ts',
      },
      [],
      true,
    );
    const imported = flagValue(argv, '--import');
    expect(imported.startsWith('file:///')).toBe(true);
    expect(imported.includes('\\')).toBe(false);
    expect(imported).toBe('file:///D:/a/code-agent/node_modules/tsx/dist/loader.mjs');
  });

  it('turns a POSIX loader path into a file URL', () => {
    const argv = assembleTsxChildArgv(
      {
        preflightPath: '/code-agent/node_modules/tsx/dist/preflight.cjs',
        loaderPath: '/code-agent/node_modules/tsx/dist/loader.mjs',
        childEntry: '/code-agent/tests/e2e/fixtures/durableRunProcessHost.ts',
      },
      ['recover', 'id', '/tmp/scenario'],
      false,
    );
    const imported = flagValue(argv, '--import');
    expect(imported.startsWith('file:///')).toBe(true);
    expect(imported.includes('\\')).toBe(false);
    expect(imported).toBe('file:///code-agent/node_modules/tsx/dist/loader.mjs');
    expect(flagValue(argv, '--require')).toBe('/code-agent/node_modules/tsx/dist/preflight.cjs');
  });
});
