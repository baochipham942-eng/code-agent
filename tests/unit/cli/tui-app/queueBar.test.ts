import { describe, expect, it } from 'vitest';
import { queueActionAt, truncateQueueText } from '../../../../src/cli/tui-app/queueBar';

describe('queueActionAt', () => {
  it('点在右侧动作上命中 send/edit/cancel，其余为 body', () => {
    const columns = 80;
    const suffix = '[Send now][edit][cancel]';
    const start1 = columns - suffix.length + 1;
    expect(queueActionAt(1, columns)).toBe('body');
    expect(queueActionAt(start1, columns)).toBe('send');
    expect(queueActionAt(start1 + '[Send now]'.length, columns)).toBe('edit');
    expect(queueActionAt(columns, columns)).toBe('cancel');
  });
});

describe('truncateQueueText', () => {
  it('超宽截断并留出动作区', () => {
    const text = truncateQueueText('hello world '.repeat(20), 40);
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThan(40);
  });
});
