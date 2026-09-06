import { describe, expect, it } from 'vitest';
import { remainingAssistantStreamDelta } from '../../../src/renderer/utils/assistantStreamDelta';

describe('remainingAssistantStreamDelta', () => {
  it('returns the incoming bytes when nothing has been flushed', () => {
    expect(remainingAssistantStreamDelta('', 'hello')).toBe('hello');
  });

  it('drops a full replay of already-flushed long content', () => {
    const answer = '腾讯会议的目录在用户数据文件夹下，常见路径包括 Documents 与 Application Support。';
    expect(remainingAssistantStreamDelta(answer, answer)).toBe('');
  });

  it('keeps a short exact token that may be a genuine repetition', () => {
    expect(remainingAssistantStreamDelta('ha', 'ha')).toBe('ha');
  });

  it('does not treat a short live token as a replayed prefix', () => {
    expect(remainingAssistantStreamDelta('hello world', 'h')).toBe('h');
  });

  it('keeps only the unread suffix when incoming is a longer snapshot', () => {
    expect(remainingAssistantStreamDelta('hello', 'hello world')).toBe(' world');
  });

  it('keeps a genuinely new continuation', () => {
    expect(remainingAssistantStreamDelta('hello', ' world')).toBe(' world');
  });
});
