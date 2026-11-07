// ============================================================================
// roleFirstWakeEmptyState — 首次醒来卡在场时空会话欢迎态让位的接线钉子
// （2026-11-05 owner 返修 D：不再叠「继续上次的会话」标题与四张起手卡）。
// 行为面（信号写入/清空）在 RoleFirstWakeCard.test.tsx；这里钉 ChatView 消费侧
// 接线（模式同 userQuestionPendingStore.appWiring.test.ts）。
// ============================================================================
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('首次醒来卡压空态接线', () => {
  const chatViewSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/components/ChatView.tsx'),
    'utf-8',
  );
  const appStoreSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/stores/appStore.ts'),
    'utf-8',
  );
  const cardSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/components/features/chat/RoleFirstWakeCard.tsx'),
    'utf-8',
  );

  it('ChatView 订阅 firstWakeCardRoleId，卡可见时 welcome 让位为 null（骨架/空白分支不受影响）', () => {
    expect(chatViewSource).toContain('const firstWakeCardRoleId = useAppStore((state) => state.firstWakeCardRoleId);');
    expect(chatViewSource).toContain('const isEmptySessionWelcomeVisible = projection.turns.length === 0');
    expect(chatViewSource).toContain('welcome={isEmptySessionWelcomeVisible ? (');
    // 让位只压 welcome：EmptySessionArea 的 hydration 骨架与冷启动空白分支原样保留
    expect(chatViewSource).toContain('isHydratingSession={isHydratingSession}');
  });

  it('专家空态 welcome 承接 wake proposals 时，顶部 banner 用同一可见条件让位', () => {
    expect(chatViewSource).toContain(
      '<RoleFirstWakeThreadBanner suppressWakeProposals={isEmptySessionWelcomeVisible} />',
    );
    expect(cardSource).toContain(
      '{!suppressWakeProposals && <RoleWakeProposalsCard roleId={roleId} framed />}',
    );
  });

  it('卡可见写信号、卸载/消失按 roleId 清回（并发两张卡不互抹）', () => {
    expect(cardSource).toContain('setFirstWakeCardRoleId(roleId)');
    expect(cardSource).toContain('setFirstWakeCardRoleId(null, roleId)');
    expect(appStoreSource).toContain('setFirstWakeCardRoleId: (roleId, previous) =>');
  });
});
