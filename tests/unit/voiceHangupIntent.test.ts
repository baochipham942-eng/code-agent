// 挂断意图匹配器（A1）。这条闸的取向是高精度低召回——误判把还在说话的人挂掉，
// 漏判只是回到「用户自己点挂断按钮」。所以边界（尤其「先这样」的误伤面）在这里钉死。
import { describe, it, expect } from 'vitest';
import { detectHangupIntent } from '../../src/host/services/voice/hangupIntent';

describe('detectHangupIntent', () => {
  it.each([
    '挂断',
    '挂断吧',
    '挂断。',
    '帮我挂断电话',
    '好了，挂电话',
    '那就挂了',
    '结束通话',
    '可以结束对话了',
    '行，先这样',
    '好的，那就先这样吧',
    '就这样吧',
    '拜拜',
    '再见！',
    '回头聊',
    '下次聊',
    '今天不聊了',
  ])('用户说「%s」= 挂断意图', (text) => {
    expect(detectHangupIntent(text)).toBe(true);
  });

  it.each([
    // 否定式：说的正是「别挂」
    '别挂断',
    '先别挂断',
    '不要结束通话',
    '不用挂断',
    '不能挂断',
    '还没挂断',
    // 词条在句中不是句尾：这是「怎么处理」，不是「挂了吧」
    '这个先这样处理然后继续',
    '就这样改一下这个函数',
    '你把电话号码写进配置里',
    '结束通话之后要做什么我再想想',
    // 普通句子
    '帮我看一下这个文件',
    '',
    '   ',
  ])('用户说「%s」≠ 挂断意图', (text) => {
    expect(detectHangupIntent(text)).toBe(false);
  });
});
