// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Slot,
  activatePluginUi,
  declareSlot,
  slots,
  unloadPluginUi,
  type DeclareSlotOptions,
} from '../../../src/renderer/slots/pluginUiSdk';

const declarations: Array<() => void> = [];
const pluginIds = new Set<string>();

function declare(name: string, kind: DeclareSlotOptions['kind'], props: Record<string, string> = {}): void {
  declarations.push(declareSlot(name, {
    kind,
    scope: 'session',
    props,
    declaredBy: 'SlotRegistryTestHost',
    replaceRisk: kind === 'single' ? 'shadows-shipped-ui' : 'none',
  }));
}

async function activate(pluginId: string, callback: () => unknown): Promise<void> {
  pluginIds.add(pluginId);
  await activatePluginUi(pluginId, callback);
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  cleanup();
  for (const pluginId of pluginIds) await unloadPluginUi(pluginId);
  pluginIds.clear();
  declarations.splice(0).reverse().forEach((dispose) => dispose());
  document.querySelectorAll('[data-plugin-ui], [data-test-plugin-effect]').forEach((node) => node.remove());
  vi.restoreAllMocks();
});

describe('ADR-062 SlotRegistry', () => {
  it('waits for declaration before running an injection and then replays it', async () => {
    const callback = vi.fn(() => {
      slots.register({ name: 'late.slot', id: 'late' }, () => <div>LATE READY</div>);
    });
    await activate('late-plugin', () => { slots.inject('late.slot', callback); });
    expect(callback).not.toHaveBeenCalled();

    declare('late.slot', 'list');
    expect(callback).toHaveBeenCalledTimes(1);
    render(<Slot name="late.slot" />);
    expect(screen.getByText('LATE READY')).toBeTruthy();
  });

  it('single keeps prior registrations and lets the later occupant shadow them', async () => {
    declare('single.slot', 'single');
    const First = () => <div>FIRST</div>;
    const Second = () => <div>SECOND</div>;
    await activate('single-first', () => { slots.register({ name: 'single.slot' }, First); });
    await activate('single-second', () => { slots.register({ name: 'single.slot' }, Second); });
    render(<Slot name="single.slot" fallback={<div>SHIPPED</div>} />);

    expect(screen.queryByText('FIRST')).toBeNull();
    expect(screen.getByText('SECOND')).toBeTruthy();
    expect(slots.get('single.slot')?.occupants).toEqual([
      { pluginId: 'single-first', status: 'shadowed' },
      { pluginId: 'single-second', status: 'active' },
    ]);
  });

  it('list appends in stable order when an identified registration refreshes', async () => {
    declare('list.slot', 'list');
    await activate('list-a', () => { slots.register({ name: 'list.slot', id: 'a' }, () => <div>A1</div>); });
    await activate('list-b', () => { slots.register({ name: 'list.slot', id: 'b' }, () => <div>B</div>); });
    const view = render(<Slot name="list.slot" />);
    expect(view.container.textContent).toBe('A1B');

    await act(() => activate('list-a', () => {
      slots.register({ name: 'list.slot', id: 'a' }, () => <div>A2</div>);
    }));
    expect(view.container.textContent).toBe('A2B');
  });

  it('keyed replaces only the occupant with the same key', async () => {
    declare('keyed.slot', 'keyed');
    await activate('keyed-a', () => { slots.register({ name: 'keyed.slot', key: 'left' }, () => <div>LEFT A</div>); });
    await activate('keyed-b', () => { slots.register({ name: 'keyed.slot', key: 'right' }, () => <div>RIGHT</div>); });
    await activate('keyed-c', () => { slots.register({ name: 'keyed.slot', key: 'left' }, () => <div>LEFT C</div>); });
    render(<Slot name="keyed.slot" />);

    expect(screen.queryByText('LEFT A')).toBeNull();
    expect(screen.getByText('LEFT C')).toBeTruthy();
    expect(screen.getByText('RIGHT')).toBeTruthy();
  });

  it('chain preserves a position for every registration', async () => {
    declare('chain.slot', 'chain');
    await activate('chain-a', () => { slots.register({ name: 'chain.slot', id: 'a' }, () => <div>ONE</div>); });
    await activate('chain-b', () => { slots.register({ name: 'chain.slot', id: 'b' }, () => <div>TWO</div>); });
    const view = render(<Slot name="chain.slot" />);
    expect(view.container.textContent).toBe('ONETWO');
  });

  it('returns the complete declaration and current occupants', async () => {
    declare('query.slot', 'list', { sessionId: 'string' });
    await activate('query-plugin', () => { slots.register({ name: 'query.slot', id: 'query' }, () => null); });
    expect(slots.get('query.slot')).toEqual({
      name: 'query.slot',
      kind: 'list',
      scope: 'session',
      props: { sessionId: 'string' },
      declaredBy: 'SlotRegistryTestHost',
      replaceRisk: 'none',
      occupants: [{ id: 'query', pluginId: 'query-plugin', status: 'active' }],
    });
  });

  it('unload removes every slot entry, managed effect, and style without plugin cleanup', async () => {
    declare('unload.slot', 'list');
    const effectNode = document.createElement('div');
    effectNode.dataset.testPluginEffect = 'unload-plugin';
    document.head.appendChild(effectNode);
    await activate('unload-plugin', () => {
      slots.register({ name: 'unload.slot', id: 'owned' }, () => <div>OWNED UI</div>);
      slots.effect(() => effectNode.remove());
      slots.addStyle('.owned-ui { color: red; }');
    });
    render(<Slot name="unload.slot" />);
    expect(screen.getByText('OWNED UI')).toBeTruthy();
    expect(document.querySelector('[data-plugin-ui="unload-plugin"]')).toBeTruthy();

    await act(() => unloadPluginUi('unload-plugin'));
    expect(screen.queryByText('OWNED UI')).toBeNull();
    expect(slots.get('unload.slot')?.occupants).toEqual([]);
    expect(document.querySelector('[data-test-plugin-effect="unload-plugin"]')).toBeNull();
    expect(document.querySelector('[data-plugin-ui="unload-plugin"]')).toBeNull();
  });

  it('single crash withdraws the failed occupant so shipped UI returns', async () => {
    declare('single.crash', 'single');
    await activate('single-crash-plugin', () => {
      slots.register({ name: 'single.crash' }, () => { throw new Error('single boom'); });
    });
    render(<Slot name="single.crash" fallback={<div>SHIPPED UI</div>} />);
    expect(await screen.findByText('SHIPPED UI')).toBeTruthy();
    expect(slots.get('single.crash')?.occupants[0]?.status).toBe('error');
  });

  it('chain crash keeps its placeholder and does not remove sibling entries', async () => {
    declare('chain.crash', 'chain');
    await activate('chain-good-a', () => { slots.register({ name: 'chain.crash', id: 'a' }, () => <div>GOOD A</div>); });
    await activate('chain-bad', () => {
      slots.register({ name: 'chain.crash', id: 'bad' }, () => { throw new Error('chain boom'); });
    });
    await activate('chain-good-b', () => { slots.register({ name: 'chain.crash', id: 'b' }, () => <div>GOOD B</div>); });
    render(<Slot name="chain.crash" />);

    expect(await screen.findByText('插件内容加载失败')).toBeTruthy();
    expect(screen.getByText('GOOD A')).toBeTruthy();
    expect(screen.getByText('GOOD B')).toBeTruthy();
  });

  it('runtime DOM guard blocks window, document.body, and hard-coded selectors', async () => {
    await expect(activatePluginUi('guard-window', () => window.location.href)).rejects.toThrow('window');
    await expect(activatePluginUi('guard-body', () => document.body.append('x'))).rejects.toThrow('document.body');
    await expect(activatePluginUi('guard-selector', () => document.querySelector('#product-root')))
      .rejects.toThrow('hard-coded DOM selector');
  });

  it('rejects an activate return value that creates a second rendering channel', async () => {
    const ReturnedComponent = () => <div>FORBIDDEN RETURN</div>;
    await expect(activatePluginUi('return-plugin', () => ReturnedComponent))
      .rejects.toThrow('activate() 不能返回 React 元素或组件');
    await waitFor(() => expect(slots.get('return.slot')).toBeUndefined());
  });
});
