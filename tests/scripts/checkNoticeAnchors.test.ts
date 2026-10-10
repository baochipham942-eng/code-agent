import { describe, expect, it } from 'vitest';
// @ts-expect-error The zero-dependency CLI intentionally exposes its test contract from plain ESM.
import { checkNotice } from '../../scripts/ci/check-notice-anchors.mjs';

const valid = `# Notice\n\n## A\n| 能力 | 锚点 |\n|---|---|\n| hook | \`src/host/hooks/index.ts#L1\` |\n\n## B\n| 请求 | 数据 | 出网执行点 |\n|---|---|---|\n| model | \`src/host/hooks/index.ts#L1\` | 待 ADR-066 |\n`;
const options = {
  exists: (file: string) => file === 'src/host/hooks/index.ts',
  lineCount: (_file: string) => 10,
};

describe('checkNotice', () => {
  it('accepts a valid two-table contract', () => {
    expect(checkNotice(valid, options)).toMatchObject({ ok: true, errors: [], warnings: [] });
  });

  it('fails with the missing anchored file', () => {
    const result = checkNotice(valid.replace('src/host/hooks/index.ts', 'src/missing.ts'), options);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('missing anchored file: src/missing.ts');
  });

  it('warns when an anchor is beyond EOF without failing', () => {
    const result = checkNotice(valid, { ...options, lineCount: () => 0 });
    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toContain('anchor beyond EOF');
  });

  it('fails on banned wording', () => {
    const result = checkNotice(`${valid}\n已加密`, options);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('banned phrase: 已加密');
  });

  it('fails when an outbound enforcement cell is filled', () => {
    const result = checkNotice(valid.replace('待 ADR-066', '全局代理'), options);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('last cell must be 待 ADR-066');
  });

  it('fails when a table row has no anchor', () => {
    const result = checkNotice(valid.replace('| hook | `src/host/hooks/index.ts#L1` |', '| hook | missing |'), options);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('table row 6 has no anchor');
  });
});
