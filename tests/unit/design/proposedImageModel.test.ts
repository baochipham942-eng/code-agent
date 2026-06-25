// ADR-026 二刀红线②：agent 不得引入新模型/端点——resolveProposedImageModel 解析口径。
import { describe, it, expect } from 'vitest';
import { resolveProposedImageModel } from '../../../src/renderer/components/design/designProposedImageGen';

describe('resolveProposedImageModel（红线②）', () => {
  it('agent 指定的内置 t2i 模型：采纳', () => {
    expect(resolveProposedImageModel('wanx-t2i', 'cogview-4')).toBe('wanx-t2i');
    expect(resolveProposedImageModel('gpt-image-2', 'wanx-t2i')).toBe('gpt-image-2');
  });

  it('未知/自定义模型 id：回退表单默认（不让 agent 引入新端点）', () => {
    expect(resolveProposedImageModel('some-custom-endpoint', 'wanx-t2i')).toBe('wanx-t2i');
    expect(resolveProposedImageModel('gpt-9-ultra', 'cogview-4')).toBe('cogview-4');
  });

  it('未指定 model：用表单默认', () => {
    expect(resolveProposedImageModel(undefined, 'wanx-t2i')).toBe('wanx-t2i');
    expect(resolveProposedImageModel('', 'flux-2')).toBe('flux-2');
  });
});
