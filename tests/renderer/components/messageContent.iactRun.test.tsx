// @vitest-environment jsdom
// IACT !run：按钮执行 href 载荷 `!run?cmd=<percent-encoded>`，不用可见链接文字。
// 裸 !run / 坏编码 / 空 cmd 不渲染按钮。执行链路（iact:run → ChatInput handleRun）不在本测试范围。

import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRunHref } from '../../../src/renderer/components/features/chat/MessageBubble/runHref';
import { encodeRunCommand, runHref } from './encodeRunCommand';

const { MessageContent } = await import(
  '../../../src/renderer/components/features/chat/MessageBubble/MessageContent'
);

async function renderAssistant(content: string) {
  const utils = render(<MessageContent content={content} isUser={false} messageId="assistant-1" />);
  await waitFor(() => {
    expect(utils.container.querySelector('[data-iact-run-command], [data-iact-run-inert]')).toBeTruthy();
  });
  return utils;
}

function collectIactRun(): { received: string[]; stop: () => void } {
  const received: string[] = [];
  const onRun = (event: Event) => {
    received.push((event as CustomEvent<string>).detail);
  };
  window.addEventListener('iact:run', onRun);
  return { received, stop: () => window.removeEventListener('iact:run', onRun) };
}

describe('IACT !run payload', () => {
  const stops: Array<() => void> = [];
  afterEach(() => {
    cleanup();
    for (const stop of stops.splice(0)) stop();
  });

  it('quotes, spaces, Chinese, colon, and parentheses round-trip into iact:run detail', async () => {
    const command = ` echo "你好: (a)'b"*+x% `;
    const { received, stop } = collectIactRun();
    stops.push(stop);
    const { container } = await renderAssistant(`[运行这段](${runHref(command)})`);

    expect(container.querySelector('[data-iact-run-command]')?.textContent).toBe(command);
    const button = container.querySelector('button');
    expect(button).toBeTruthy();
    fireEvent.click(button as HTMLButtonElement);
    expect(received).toEqual([command]);
    expect(received[0]).toBe(command);
  });

  it('label differing from payload dispatches and displays the payload', async () => {
    const label = '查看类型检查';
    const command = 'npm run typecheck';
    const { received, stop } = collectIactRun();
    stops.push(stop);
    const { container } = await renderAssistant(`[${label}](${runHref(command)})`);

    expect(container.querySelector('[data-iact-run-label]')?.textContent).toBe(label);
    expect(container.querySelector('[data-iact-run-command]')?.textContent).toBe(command);
    const button = container.querySelector('button');
    expect(button).toBeTruthy();
    expect(button?.textContent).not.toContain(label);
    fireEvent.click(button as HTMLButtonElement);
    expect(received).toEqual([command]);
  });

  it('bare !run and malformed percent-encoding render no button', async () => {
    const cases = [
      '[运行](!run)',
      '[运行](!run?cmd=%ZZ)',
      '[运行](!run?cmd=%E4%B8)',
      '[运行](!run?cmd=)',
      '[运行](!run?foo=bar)',
    ];
    for (const content of cases) {
      const { received, stop } = collectIactRun();
      stops.push(stop);
      const { container } = await renderAssistant(content);
      expect(container.querySelector('button'), content).toBeNull();
      expect(container.querySelector('a'), content).toBeNull();
      expect(container.querySelector('[data-iact-run-command]'), content).toBeNull();
      expect(container.querySelector('[data-iact-run-inert]')?.textContent, content).toBe('运行');
      expect(received, content).toEqual([]);
      cleanup();
    }
  });

  it('encoder and parser round-trip without trimming or turning + into space', () => {
    const command = ` echo "你好: (a)'b"*+x% `;
    expect(parseRunHref(runHref(command))).toBe(command);
    expect(parseRunHref('!run')).toBeNull();
    expect(parseRunHref('!run?cmd=')).toBeNull();
    expect(parseRunHref('!run?cmd=%ZZ')).toBeNull();
    expect(parseRunHref(`!run?cmd=${encodeRunCommand('a+b')}`)).toBe('a+b');
  });
});
