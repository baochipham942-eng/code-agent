import { describe, expect, it } from 'vitest';
import { parseToolNameListFlag } from '../../../src/cli/utils/toolListFlags';

// --tools / --disallowed-tools 逗号分隔列表解析（CLI flag → run policy 名单）
describe('parseToolNameListFlag', () => {
  it('未传 flag → undefined（保证无 flag 时行为完全不变）', () => {
    expect(parseToolNameListFlag(undefined)).toBeUndefined();
  });

  it('空串 / 全空白 / 只有逗号 → undefined', () => {
    expect(parseToolNameListFlag('')).toBeUndefined();
    expect(parseToolNameListFlag('   ')).toBeUndefined();
    expect(parseToolNameListFlag(',, ,')).toBeUndefined();
  });

  it('按逗号切分并 trim', () => {
    expect(parseToolNameListFlag('Bash, Read ,Edit')).toEqual(['Bash', 'Read', 'Edit']);
  });

  it('保序去重', () => {
    expect(parseToolNameListFlag('Bash,Read,Bash')).toEqual(['Bash', 'Read']);
  });

  it('skill: 前缀原样透传（技能延迟工具的原生命名）', () => {
    expect(parseToolNameListFlag('skill:pdf,Bash')).toEqual(['skill:pdf', 'Bash']);
  });
});
