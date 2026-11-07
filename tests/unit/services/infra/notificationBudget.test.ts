import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  NotificationBudget,
  type NotificationBudgetItem,
  type NotificationBudgetTimer,
} from '../../../../src/host/services/infra/notificationBudget';
import { NOTIFICATION_BUDGET } from '../../../../src/shared/constants';

interface TestItem extends NotificationBudgetItem {
  id: string;
}

function item(id: string, overrides: Partial<NotificationBudgetItem> = {}): TestItem {
  return {
    id,
    intent: 'task_complete',
    title: `title-${id}`,
    sessionId: `session-${id}`,
    ...overrides,
  };
}

describe('NotificationBudget', () => {
  let now: number;
  let pending: (() => void) | undefined;
  let budget: NotificationBudget<TestItem>;
  let deliver: Mock<(entry: TestItem) => void>;
  let deliverDigest: Mock<(entries: readonly TestItem[]) => void>;
  let setTimer: Mock<(callback: () => void, delayMs: number) => NotificationBudgetTimer>;
  let clearTimer: Mock<(handle: NotificationBudgetTimer) => void>;
  let timer: { unref: Mock<() => void> };

  beforeEach(() => {
    now = 0;
    pending = undefined;
    deliver = vi.fn();
    deliverDigest = vi.fn();
    timer = { unref: vi.fn() };
    setTimer = vi.fn((callback: () => void) => {
      pending = callback;
      return timer;
    });
    clearTimer = vi.fn(() => {
      pending = undefined;
    });
    budget = new NotificationBudget<TestItem>({
      deliver,
      deliverDigest,
      now: () => now,
      setTimer,
      clearTimer,
    });
  });

  function advanceWindow(): void {
    now += NOTIFICATION_BUDGET.WINDOW_MS;
    const callback = pending;
    pending = undefined;
    callback?.();
  }

  it('delivers the first ordinary item immediately and holds later items in the window', () => {
    const first = item('first');
    const second = item('second');
    budget.enqueue(first);
    budget.enqueue(second);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(first);
    expect(deliverDigest).not.toHaveBeenCalled();
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), NOTIFICATION_BUDGET.WINDOW_MS);
    expect(timer.unref).toHaveBeenCalledTimes(1);
  });

  it('clears an empty window so the next item is first again', () => {
    budget.enqueue(item('first'));
    advanceWindow();
    deliver.mockClear();

    const next = item('next');
    budget.enqueue(next);
    expect(deliver).toHaveBeenCalledWith(next);
    expect(setTimer).toHaveBeenCalledTimes(2);
  });

  it('delivers one held item unchanged at window end', () => {
    budget.enqueue(item('first'));
    const held = item('held');
    budget.enqueue(held);
    advanceWindow();

    expect(deliver).toHaveBeenNthCalledWith(2, held);
    expect(deliverDigest).not.toHaveBeenCalled();
    expect(setTimer).toHaveBeenCalledTimes(1);
  });

  it('folds multiple held items into one digest and opens the next window', () => {
    budget.enqueue(item('first'));
    const held = [item('second'), item('third'), item('fourth')];
    held.forEach((entry) => budget.enqueue(entry));
    advanceWindow();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliverDigest).toHaveBeenCalledWith(held);
    expect(setTimer).toHaveBeenCalledTimes(2);

    budget.enqueue(item('next-window'));
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('delivers exempt items immediately without opening or consuming a window', () => {
    const exemptions = [
      item('input', { intent: 'needs_input' }),
      item('failed', { intent: 'task_failed' }),
      item('urgent', { urgent: true }),
    ];
    exemptions.forEach((entry) => budget.enqueue(entry));

    expect(deliver.mock.calls.map(([entry]) => entry)).toEqual(exemptions);
    expect(setTimer).not.toHaveBeenCalled();

    const first = item('ordinary-first');
    budget.enqueue(first);
    expect(deliver).toHaveBeenLastCalledWith(first);
    expect(setTimer).toHaveBeenCalledTimes(1);
  });

  it('reports each enqueue as delivered or held so callers can flush side effects promptly', () => {
    expect(budget.enqueue(item('first'))).toBe('delivered');
    expect(budget.enqueue(item('held'))).toBe('held');
    expect(budget.enqueue(item('urgent', { urgent: true }))).toBe('delivered');
    expect(budget.enqueue(item('input', { intent: 'needs_input' }))).toBe('delivered');
  });

  it('clear drops held items and resets the next item to first', () => {
    budget.enqueue(item('first'));
    budget.enqueue(item('held'));
    budget.clear();

    expect(clearTimer).toHaveBeenCalledWith(timer);
    advanceWindow();
    expect(deliverDigest).not.toHaveBeenCalled();

    const next = item('after-clear');
    budget.enqueue(next);
    expect(deliver).toHaveBeenNthCalledWith(2, next);
    expect(setTimer).toHaveBeenCalledTimes(2);
  });
});
