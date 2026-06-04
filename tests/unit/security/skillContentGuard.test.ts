// ============================================================================
// SkillContentGuard Tests — skill 草稿入库前内容安全扫描（fail-closed）
// 命令路径用真 validateCommand；密钥路径 mock sensitiveDetector 控制返回，
// 避免在仓库里写入真实密钥触发 pre-commit 扫描。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const detectorMocks = vi.hoisted(() => ({
  detect: vi.fn<(text: string) => { hasSensitive: boolean; matches: unknown[]; count: number }>(
    () => ({ hasSensitive: false, matches: [], count: 0 }),
  ),
}));

vi.mock('../../../src/main/security/sensitiveDetector', () => ({
  getSensitiveDetector: () => ({ detect: detectorMocks.detect }),
}));

import { extractCodeSegments, scanSkillContent } from '../../../src/main/security/skillContentGuard';

beforeEach(() => {
  detectorMocks.detect.mockReset();
  detectorMocks.detect.mockReturnValue({ hasSensitive: false, matches: [], count: 0 });
});

describe('extractCodeSegments', () => {
  it('抽取 fenced code block 的每一行', () => {
    const md = '正文\n```bash\nnpm run build\nrm -rf /\n```\n更多正文';
    const segs = extractCodeSegments(md);
    expect(segs).toContain('npm run build');
    expect(segs).toContain('rm -rf /');
    expect(segs).not.toContain('正文');
  });

  it('抽取行内 code span', () => {
    const md = '执行 `cargo tauri build` 然后用 `scripts/tauri-install.sh`';
    const segs = extractCodeSegments(md);
    expect(segs).toContain('cargo tauri build');
    expect(segs).toContain('scripts/tauri-install.sh');
  });
});

describe('scanSkillContent', () => {
  it('正常 skill（安全命令）→ pass', () => {
    const md = [
      '---',
      'name: deploy',
      '---',
      '# deploy',
      '```bash',
      'npm run typecheck',
      'npm run build',
      '```',
      '执行 `git status` 查看状态',
    ].join('\n');
    expect(scanSkillContent(md).verdict).toBe('pass');
  });

  it('代码块含 critical 危险命令 → block', () => {
    const md = '# bad\n```bash\nrm -rf /\n```';
    const result = scanSkillContent(md);
    expect(result.verdict).toBe('block');
    expect(result.findings.some((f) => f.kind === 'dangerous_command')).toBe(true);
  });

  it('行内危险命令 → block', () => {
    const md = '第一步：运行 `mkfs.ext4 /dev/sda` 格式化';
    expect(scanSkillContent(md).verdict).toBe('block');
  });

  it('高置信嵌入密钥 → block', () => {
    detectorMocks.detect.mockReturnValue({
      hasSensitive: true,
      count: 1,
      matches: [{ type: 'api_key', confidence: 'high', masked: 'sk-...abcd' }],
    });
    const result = scanSkillContent('# skill\n配置 token: <已脱敏>');
    expect(result.verdict).toBe('block');
    expect(result.findings.some((f) => f.kind === 'embedded_secret')).toBe(true);
  });

  it('低置信密钥匹配 → 不拦（避免误伤）', () => {
    detectorMocks.detect.mockReturnValue({
      hasSensitive: true,
      count: 1,
      matches: [{ type: 'generic', confidence: 'low', masked: 'xxx' }],
    });
    expect(scanSkillContent('# skill\n普通文本').verdict).toBe('pass');
  });
});
