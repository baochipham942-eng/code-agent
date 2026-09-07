import { describe, expect, it } from 'vitest';
import {
  lenientCompoundSegments,
  splitCompoundCommand,
} from '../../../src/host/security/commandSafety';

// 第 42 轮（N-BASHAST 结构性收口）：splitCompoundCommand 在 parsingFailed/trailingOperator 时
// 返回 null，一个布尔位把 parseEntries 已经建好的段视图整个丢掉——分类器回退到原 cwd 整串扫描，
// cd 的 cwd 推进随之丢失（rounds 32-41 同族）。lenientCompoundSegments 是它的宽松兄弟视图：
// 解析失败照样返回段（与 lenientCommandWords「a command we cannot structure must widen their
// view, never empty it」同一立场，抬到段级），只有段列表真为空才返回 null。
describe('lenientCompoundSegments — 解析失败不丢段视图', () => {
  it('keeps every list boundary of a word-free-segment compound', () => {
    const view = lenientCompoundSegments('cd ~ && 2>&1; rm -rf .ssh/id_rsa');

    expect(view).not.toBeNull();
    expect(view!.segments).toEqual(['cd \\~', '', 'rm -rf .ssh/id_rsa']);
    expect(view!.terminators).toHaveLength(view!.segments.length);
    expect(view!.terminators).toEqual(['&&', ';', null]);
  });

  it('returns the segments even where the strict parse fails (heredoc)', () => {
    const view = lenientCompoundSegments('cd ~ && cat <<x; rm -rf .ssh/id_rsa');

    expect(view).not.toBeNull();
    expect(view!.segments).toHaveLength(3);
    expect(view!.terminators).toHaveLength(view!.segments.length);
    expect(view!.terminators).toEqual(['&&', ';', null]);
  });

  it('keeps the final segment of a trailing operator', () => {
    const view = lenientCompoundSegments('cd x &&');

    expect(view).not.toBeNull();
    expect(view!.segments).toEqual(['cd x']);
    expect(view!.terminators).toEqual(['&&']);
  });

  it('returns null only when the parse produced no segments at all', () => {
    expect(lenientCompoundSegments('ls ${')).toBeNull();
  });

  it('splitCompoundCommand keeps its strict semantics unchanged', () => {
    // 批准证明的输入必须保持 fail-closed：解析失败/悬空算符仍返回 null，可解析形状的段文本
    // 与 lenient 视图同源（同一套重建逻辑），一字未动。
    expect(splitCompoundCommand('cd ~ && cat <<x; rm -rf .ssh/id_rsa')).toBeNull();
    expect(splitCompoundCommand('cd x &&')).toBeNull();
    expect(splitCompoundCommand('cd ~ && 2>&1; rm -rf .ssh/id_rsa'))
      .toEqual(['cd \\~', '', 'rm -rf .ssh/id_rsa']);
  });
});
