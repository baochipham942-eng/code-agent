import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error —— 纯 JS 静态门脚本，无类型声明
import { scan, LOCAL_DISPLAY_PRIMITIVE_RE } from '../../scripts/check-design-system.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RENDERER = join(here, '../../src/renderer');

// A1 展示类 primitive 收敛契约（maka 借鉴，收窄版）：
// EmptyState/Badge 只允许定义在 components/primitives/，调用点一律 import 自 primitives。
// 守卫真源 = check-design-system.mjs 的 local-display-primitive 规则（棘轮基线 0）。
describe('primitives convergence (EmptyState/Badge)', () => {
  it('旧本地定义已全部退役（local-display-primitive 违规为 0）', () => {
    const violations = scan() as Record<string, string[]>;
    expect(violations['local-display-primitive']).toEqual([]);
  });

  it('守卫正则对故意违例样本红', () => {
    const re = LOCAL_DISPLAY_PRIMITIVE_RE as RegExp;
    expect(re.test('const EmptyState: React.FC<{ text: string }> = ({ text }) => (')).toBe(true);
    expect(re.test('export function EmptyState({ icon, title, text }) {')).toBe(true);
    expect(re.test('const Badge = ({ children }: Props) => <span>{children}</span>;')).toBe(true);
    expect(re.test('export function Badge(props: BadgeProps) {')).toBe(true);
  });

  it('守卫正则不误伤领域徽标组件与合法 import', () => {
    const re = LOCAL_DISPLAY_PRIMITIVE_RE as RegExp;
    expect(re.test('export function ProviderBillingBadge({ summary }) {')).toBe(false);
    expect(re.test('export function CardEmptyState({ text }: { text: string }) {')).toBe(false);
    expect(re.test("import { Badge, EmptyState } from '../primitives';")).toBe(false);
    expect(re.test('const NewSessionWelcome: React.FC = () => null;')).toBe(false);
  });

  const IMPORT_FROM_PRIMITIVES = (name: string) =>
    new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'[^']*primitives'`);

  const emptyStateCallSites = [
    'components/features/settings/tabs/PluginsSettings.tsx',
    'components/PlanningPanel.tsx',
    'components/features/knowledge/KnowledgeMemoryPanel.tsx',
    'components/TaskPanel/RunWorkbenchCards.tsx',
    'components/TaskPanel/TaskMonitor.tsx',
  ];
  for (const rel of emptyStateCallSites) {
    it(`${rel} 的 EmptyState import 自 primitives`, () => {
      const src = readFileSync(join(RENDERER, rel), 'utf8');
      expect(src).toMatch(IMPORT_FROM_PRIMITIVES('EmptyState'));
    });
  }

  const badgeCallSites = [
    'components/StatusBar/modelSwitcherHelpers.tsx',
    'components/features/settings/tabs/AgentEngineListSection.tsx',
    'components/features/projectCollaboration/ProjectCollaborationDetailPane.tsx',
    'components/features/knowledge/KnowledgeMemoryPanel.parts.tsx',
    'components/workspacePreview/parts.tsx',
  ];
  for (const rel of badgeCallSites) {
    it(`${rel} 的 Badge import 自 primitives`, () => {
      const src = readFileSync(join(RENDERER, rel), 'utf8');
      expect(src).toMatch(IMPORT_FROM_PRIMITIVES('Badge'));
    });
  }

  it('TaskPanel/Card.tsx 的 CardEmptyState 已退役', () => {
    const src = readFileSync(join(RENDERER, 'components/TaskPanel/Card.tsx'), 'utf8');
    expect(src).not.toContain('CardEmptyState');
  });
});
