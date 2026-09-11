import { describe, expect, it } from 'vitest';
import { resolveFollowableArtifactPath } from '../../../src/renderer/utils/artifactFollow';

describe('resolveFollowableArtifactPath', () => {
  it('passes POSIX absolute paths through', () => {
    expect(resolveFollowableArtifactPath('/work/product.png', '/work')).toBe('/work/product.png');
  });

  it('passes Windows drive-letter and UNC paths through without re-joining', () => {
    // 生产侧现在直接产出绝对路径；win32 绝对值不能再被拼一次工作目录（修正轮 10 回归钉）。
    expect(resolveFollowableArtifactPath('C:\\work\\product.png', 'C:\\work')).toBe('C:\\work\\product.png');
    expect(resolveFollowableArtifactPath('C:/work/product.png', 'C:/work')).toBe('C:/work/product.png');
    expect(resolveFollowableArtifactPath('\\\\host\\share\\product.png', 'D:\\x')).toBe('\\\\host\\share\\product.png');
  });

  it('still joins genuinely relative paths against the working directory', () => {
    expect(resolveFollowableArtifactPath('./product.png', '/work')).toBe('/work/product.png');
    expect(resolveFollowableArtifactPath('out/product.png', '/work/')).toBe('/work/out/product.png');
  });

  it('returns null for non-followable extensions', () => {
    expect(resolveFollowableArtifactPath('/work/archive.zip', '/work')).toBeNull();
  });
});
