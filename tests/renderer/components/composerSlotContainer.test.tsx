// @vitest-environment jsdom
// ============================================================================
// ComposerSlot 容器行为门
// ----------------------------------------------------------------------------
// 1. 未声明层级的组件渲染不出来（核心：防以后又塞进来一个不声明层级的）
// 2. 那一格出现非 SlotEntry 的直接子节点就报错
// 3. 自闸占用者不能被「没登记就不挂 → 不挂就登记不了」死锁
// 4. L1 阻塞层同时来两张就摞，都不让位
// 5. L3 上下文层不让位；被 L1 挤时由 selectSlotCollapsed 回答「挤不挤」
// 6. L4 建议层：L1 或 L2 有货整层隐藏；L3 有货**不**隐藏（多人会话不能永久没建议）
// 7. 挂载清单与 COMPOSER_SLOT_LAYER 双向对齐（登记了没接 / 接了没登记都报红）
// ============================================================================

import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ComposerSlot, SlotEntry } from '../../../src/renderer/components/features/chat/ChatInput/ComposerSlot';
import {
  COMPOSER_SLOT_LAYER,
  selectSlotCollapsed,
  useComposerNoticeStore,
} from '../../../src/renderer/stores/composerNoticeStore';
import type { ComposerSlotOccupantId } from '../../../src/renderer/stores/composerNoticeStore';

function resetSlotStore(): void {
  useComposerNoticeStore.setState({ notices: {}, inProgress: {}, slotActive: {} });
}

/** 挂载点声明活跃态的占位 occupant（走 SlotEntry 的显隐判定） */
function mountGated(id: ComposerSlotOccupantId, active: boolean) {
  return (
    <SlotEntry id={id} active={active}>
      <div data-testid={`occupant-${id}`} />
    </SlotEntry>
  );
}

/** 自闸占位 occupant（活跃态由组件自己登记，容器只做层级压制） */
function selfGated(id: ComposerSlotOccupantId) {
  return (
    <SlotEntry id={id}>
      <div data-testid={`occupant-${id}`} />
    </SlotEntry>
  );
}

describe('ComposerSlot 容器', () => {
  beforeEach(resetSlotStore);
  afterEach(() => {
    cleanup();
    resetSlotStore();
  });

  // ── 判据 1：未声明层级的组件渲染不出来 ──
  it('未在 COMPOSER_SLOT_LAYER 登记的 id 直接拒渲染（抛错）', () => {
    const rogue = (
      <ComposerSlot>
        {/* @ts-expect-error 故意用未登记 id 验证运行时门 */}
        <SlotEntry id="rogue-occupant"><div /></SlotEntry>
      </ComposerSlot>
    );
    expect(() => render(rogue)).toThrow(/未在 COMPOSER_SLOT_LAYER 登记/);
  });

  // ── 判据 2：门——那一格只准 SlotEntry 进 ──
  it('槽位里裸挂非 SlotEntry 组件直接报错', () => {
    const rogue = (
      <ComposerSlot>
        <div data-testid="rogue-bare-node" />
      </ComposerSlot>
    );
    expect(() => render(rogue)).toThrow(/只渲染 <SlotEntry id>/);
  });

  it('L2 进行中层不许由挂载点声明 active（互斥表读的是 inProgress，那样会静默永不显示）', () => {
    expect(() => render(<ComposerSlot>{mountGated('upload', true)}</ComposerSlot>))
      .toThrow(/必须走 useRegisterComposerInProgress/);
  });

  it('挂载点声明活跃的 occupant：没活跃不渲染，活跃了才渲染', () => {
    const { rerender } = render(<ComposerSlot>{mountGated('goal-confirm', false)}</ComposerSlot>);
    expect(screen.queryByTestId('occupant-goal-confirm')).toBeNull();
    rerender(<ComposerSlot>{mountGated('goal-confirm', true)}</ComposerSlot>);
    expect(screen.getByTestId('occupant-goal-confirm')).toBeTruthy();
  });

  // ── 判据 3：自闸占用者不能被死锁 ──
  // 草稿卡 / 通话 / 上传 / 成员条的活跃态写在它们自己的 effect 里，必须先挂上去才登记得了。
  // 容器若按「登记了才挂」来判，它们就永远登记不上、永远不显示。
  it('自闸占用者在 store 里零登记时照样挂载（否则登记与挂载互相死锁）', () => {
    render(
      <ComposerSlot>
        {selfGated('skill-draft')}
        {selfGated('member-bar')}
        {selfGated('voice')}
      </ComposerSlot>,
    );
    expect(useComposerNoticeStore.getState().slotActive).toEqual({});
    expect(screen.getByTestId('occupant-skill-draft')).toBeTruthy();
    expect(screen.getByTestId('occupant-member-bar')).toBeTruthy();
    expect(screen.getByTestId('occupant-voice')).toBeTruthy();
  });

  // ── 判据 4：L1 同时来两张就摞 ──
  it('L1 阻塞层：草稿卡与目标确认卡同时活跃时都渲染', () => {
    render(
      <ComposerSlot>
        {selfGated('skill-draft')}
        {mountGated('goal-confirm', true)}
      </ComposerSlot>,
    );
    act(() => { useComposerNoticeStore.getState().setNotice('skill-draft', true); });
    expect(screen.getByTestId('occupant-skill-draft')).toBeTruthy();
    expect(screen.getByTestId('occupant-goal-confirm')).toBeTruthy();
  });

  // ── 判据 5：L3 不让位 ──
  it('L3 上下文层：L1 阻塞卡在场时成员条照样渲染（不让位）', () => {
    render(
      <ComposerSlot>
        {mountGated('member-bar', true)}
      </ComposerSlot>,
    );
    expect(screen.getByTestId('occupant-member-bar')).toBeTruthy();
    act(() => { useComposerNoticeStore.getState().setNotice('role-draft', true); });
    expect(screen.getByTestId('occupant-member-bar')).toBeTruthy();
  });

  it('L3 收缩判定：L1 阻塞卡在场时成员条收摘要', () => {
    const collapsed = () => selectSlotCollapsed(useComposerNoticeStore.getState(), 'member-bar');
    expect(collapsed()).toBe(false);

    act(() => { useComposerNoticeStore.getState().setNotice('team-recipe-draft', true); });
    expect(collapsed()).toBe(true);
    act(() => { useComposerNoticeStore.getState().setNotice('team-recipe-draft', false); });
    expect(collapsed()).toBe(false);

    // 定时/目标/种子三张创建卡与草稿卡同属 L1，同样让成员条收摘要
    act(() => { useComposerNoticeStore.getState().setSlotActive('seed-composer', true); });
    expect(collapsed()).toBe(true);
  });

  // ── 判据 6：L4 让位 ──
  it('L4 建议层：L1 有阻塞卡时整层不渲染，卡收掉后恢复', () => {
    render(
      <ComposerSlot>
        {mountGated('suggestion-bar', true)}
        {mountGated('plan-entry', true)}
      </ComposerSlot>,
    );
    expect(screen.getByTestId('occupant-suggestion-bar')).toBeTruthy();
    expect(screen.getByTestId('occupant-plan-entry')).toBeTruthy();

    act(() => { useComposerNoticeStore.getState().setNotice('role-draft', true); });
    expect(screen.queryByTestId('occupant-suggestion-bar')).toBeNull();
    expect(screen.queryByTestId('occupant-plan-entry')).toBeNull();

    act(() => { useComposerNoticeStore.getState().setNotice('role-draft', false); });
    expect(screen.getByTestId('occupant-suggestion-bar')).toBeTruthy();
    expect(screen.getByTestId('occupant-plan-entry')).toBeTruthy();
  });

  it('L4 建议层：L2 进行中时整层不渲染，跑完恢复', () => {
    render(<ComposerSlot>{mountGated('capability-strip', true)}</ComposerSlot>);
    expect(screen.getByTestId('occupant-capability-strip')).toBeTruthy();

    act(() => { useComposerNoticeStore.getState().setInProgress('upload', true); });
    expect(screen.queryByTestId('occupant-capability-strip')).toBeNull();

    act(() => { useComposerNoticeStore.getState().setInProgress('upload', false); });
    expect(screen.getByTestId('occupant-capability-strip')).toBeTruthy();
  });

  // 与 2026-07-28 初版的差异，钉死别被「对齐旧分支」改回去：L3 不进 L4 的让位条件。
  // member-bar 在整个多智能体会话里全程活跃，含 L3 等于「多人会话永远看不到能力建议」。
  it('L4 建议层：L3 上下文有货时**不**让位', () => {
    render(<ComposerSlot>{mountGated('combo-skill', true)}</ComposerSlot>);
    act(() => {
      const store = useComposerNoticeStore.getState();
      store.setSlotActive('member-bar', true);
    });
    expect(screen.getByTestId('occupant-combo-skill')).toBeTruthy();
  });

  it('自闸占用者也吃 L4 让位（压制走同一处判定，不看是谁登记的）', () => {
    render(<ComposerSlot>{selfGated('suggestion-bar')}</ComposerSlot>);
    expect(screen.getByTestId('occupant-suggestion-bar')).toBeTruthy();
    act(() => { useComposerNoticeStore.getState().setNotice('skill-draft', true); });
    expect(screen.queryByTestId('occupant-suggestion-bar')).toBeNull();
  });
});

// ── 判据 7：登记表与真实挂载清单双向对齐 ──
describe('COMPOSER_SLOT_LAYER 与 ChatInput 挂载清单', () => {
  const CHAT_INPUT_PATH = resolve(
    process.cwd(),
    'src/renderer/components/features/chat/ChatInput/index.tsx',
  );

  /** 取 <ComposerSlot> … </ComposerSlot> 之间的正文。
      注释必须先于定位剥掉：注释里也会写 <ComposerSlot>，先 indexOf 会锚到注释上。 */
  function slotBlock(): string {
    const source = readFileSync(CHAT_INPUT_PATH, 'utf8').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    const open = source.indexOf('<ComposerSlot>');
    const close = source.indexOf('</ComposerSlot>');
    expect(open, '找不到 ComposerSlot 挂载块，本门的锚点已失效，请修门而不是放行')
      .toBeGreaterThan(-1);
    expect(close, '找不到 ComposerSlot 收尾锚点，本门的锚点已失效，请修门而不是放行')
      .toBeGreaterThan(open);
    return source.slice(open + '<ComposerSlot>'.length, close);
  }

  function mountedOccupantIds(): string[] {
    return [...slotBlock().matchAll(/<SlotEntry\s[^>]*?id="([^"]+)"/g)].map((match) => match[1]);
  }

  it('挂载清单里的每个 id 都登记过层级', () => {
    const registered = new Set(Object.keys(COMPOSER_SLOT_LAYER));
    for (const id of mountedOccupantIds()) {
      expect(registered.has(id), `占用者 "${id}" 挂在那一格却没在 COMPOSER_SLOT_LAYER 登记层级`).toBe(true);
    }
  });

  it('登记过层级的每个 id 都真的挂着（登记了没接 = 死登记）', () => {
    const mounted = new Set(mountedOccupantIds());
    for (const id of Object.keys(COMPOSER_SLOT_LAYER)) {
      expect(mounted.has(id), `占用者 "${id}" 登记了层级却没有挂载点，登记表里留了死条目`).toBe(true);
    }
  });

  it('挂载清单没有重复 id（同一个占用者只许有一个挂载点）', () => {
    const ids = mountedOccupantIds();
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // 容器的运行时门要真机渲染 ChatInput 才会响，而没有测试渲染整个 ChatInput。
  // 这条把同一件事静态钉住：那一格的顶层只准是 SlotEntry，别的裸节点一个都不许有。
  it('挂载块顶层没有 SlotEntry 之外的裸节点', () => {
    const block = slotBlock();
    let depth = 0;
    let topLevelResidue = '';
    for (let i = 0; i < block.length; i += 1) {
      if (block.startsWith('</SlotEntry>', i)) {
        depth -= 1;
        i += '</SlotEntry>'.length - 1;
        continue;
      }
      if (block.startsWith('<SlotEntry', i)) {
        depth += 1;
        i += '<SlotEntry'.length - 1;
        continue;
      }
      if (depth === 0) topLevelResidue += block[i];
    }
    expect(depth, '挂载块里的 SlotEntry 开合不配对，本门的锚点已失效，请修门而不是放行').toBe(0);
    expect(
      topLevelResidue.trim(),
      `那一格顶层混进了非 SlotEntry 的内容：${topLevelResidue.trim().slice(0, 120)}`,
    ).toBe('');
  });
});
