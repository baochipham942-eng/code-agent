// @vitest-environment jsdom
//
// 排队（引导）消息卡的形态门。
//
// 旧形态把排队项渲染进输入框容器内部（textarea 与底部工具栏之间），气泡撑高输入区，
// 多条排队一条一个气泡占掉半屏。本门钉住新形态的三条硬要求：
//   1. 卡片是输入框的兄弟节点，不在输入框容器里（结构性断言，见 chatInput 位置那条）
//   2. 折叠态只露计数，不铺正文
//   3. 运行中给的是「插队发送」——#679 藏按钮是因为那时 running 档点了真发不出去；
//      #773 实现了「回复中立即转向」后这个前提就没了，按钮必须跟着开，否则等于把
//      已实现的插队能力锁死，用户只剩「排队等它跑完」一条路。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueuedRuntimeInputCard } from '../../../src/renderer/components/features/chat/ChatInput/QueuedRuntimeInputCard';

function items(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `queued-${index}`,
    content: `引导正文 ${index}`,
    attachmentsCount: 0,
  }));
}

describe('QueuedRuntimeInputCard', () => {
  it('多条默认折叠：只露计数，不铺正文', () => {
    render(<QueuedRuntimeInputCard items={items(3)} isProcessing={false} />);

    expect(screen.getByTestId('queued-runtime-input-count').textContent).toContain('3');
    expect(screen.queryByText('引导正文 0')).toBeNull();

    fireEvent.click(screen.getByTestId('queued-runtime-input-toggle'));
    expect(screen.getByText('引导正文 0')).toBeTruthy();
  });

  it('单条直接展开且不给折叠钮（就一行，藏起来只是多一次点击）', () => {
    render(<QueuedRuntimeInputCard items={items(1)} isProcessing={false} />);

    expect(screen.getByText('引导正文 0')).toBeTruthy();
    expect(screen.queryByTestId('queued-runtime-input-toggle')).toBeNull();
  });

  it('运行中也能发（走插队/转向），撤回始终可用', () => {
    const onSend = vi.fn();
    const onCancel = vi.fn();
    render(
      <QueuedRuntimeInputCard items={items(1)} isProcessing onSend={onSend} onCancel={onCancel} />,
    );

    const sendButton = screen.getByTestId('queued-runtime-input-send-queued-0');
    // 文案要区分：运行中点下去是打断当轮插进去，不是"等它跑完再发"
    expect(sendButton.getAttribute('title')).toContain('插队');
    // 主动作带文字标签——两个裸图标按钮认不出谁是谁（真机反馈 2026-08-01）
    expect(sendButton.textContent).toContain('立即发送');
    fireEvent.click(sendButton);
    expect(onSend).toHaveBeenCalledWith('queued-0');

    fireEvent.click(screen.getByTestId('queued-runtime-input-withdraw-queued-0'));
    expect(onCancel).toHaveBeenCalledWith('queued-0');
  });

  it('取消按钮的提示要说明内容会退回输入框', () => {
    render(<QueuedRuntimeInputCard items={items(1)} isProcessing={false} onCancel={vi.fn()} />);

    expect(
      screen.getByTestId('queued-runtime-input-withdraw-queued-0').getAttribute('title'),
    ).toContain('退回输入框');
  });

  it('空闲时点发送把 id 交回去', () => {
    const onSend = vi.fn();
    render(<QueuedRuntimeInputCard items={items(1)} isProcessing={false} onSend={onSend} />);

    fireEvent.click(screen.getByTestId('queued-runtime-input-send-queued-0'));
    expect(onSend).toHaveBeenCalledWith('queued-0');
  });

  // 结构性断言：卡片必须在输入框容器**之前**闭合，即它是兄弟节点而不是子节点。
  // 用「渲染顺序 + 不在容器内」而不是 toContain 某个 class，避免样式微调就误红。
  it('卡片挂在输入框容器外面（回到容器内就会重新撑高输入区）', () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        'src/renderer/components/features/chat/ChatInput/index.tsx',
      ),
      'utf8',
    );

    const cardIndex = source.indexOf('<QueuedRuntimeInputCard');
    const containerIndex = source.indexOf('composer-elevated rounded-2xl');
    expect(cardIndex, '找不到排队卡的挂载点，本门的锚点已失效，请修门而不是放行')
      .toBeGreaterThan(-1);
    expect(containerIndex, '找不到输入框容器锚点，本门的锚点已失效，请修门而不是放行')
      .toBeGreaterThan(-1);
    expect(cardIndex, '排队卡被挪回输入框容器内部了——它会重新撑高输入区')
      .toBeLessThan(containerIndex);
  });
});
