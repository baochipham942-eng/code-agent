import { describe, expect, it } from 'vitest';

import { resolveMutationAcceptanceExitCode } from '../../../scripts/acceptance/mutationExitCode';

// N-BGSPAWN-DURABLE ai-review 修复：变异模式下「断言全过」= 变异未被抓到，
// 验收无效，必须非零退出；断言转红才是预期（退出 0）。非变异模式语义不变。
describe('resolveMutationAcceptanceExitCode', () => {
  it('non-mutation mode keeps pass→0 / fail→1', () => {
    expect(resolveMutationAcceptanceExitCode(true, undefined)).toBe(0);
    expect(resolveMutationAcceptanceExitCode(false, undefined)).toBe(1);
  });

  it('mutation caught (gates red) exits 0', () => {
    expect(resolveMutationAcceptanceExitCode(false, 'omit-handler')).toBe(0);
    expect(resolveMutationAcceptanceExitCode(false, 'skip-begin')).toBe(0);
  });

  it('mutation not caught (gates green) exits non-zero — acceptance invalid', () => {
    expect(resolveMutationAcceptanceExitCode(true, 'omit-handler')).not.toBe(0);
    expect(resolveMutationAcceptanceExitCode(true, 'skip-begin')).not.toBe(0);
  });
});
