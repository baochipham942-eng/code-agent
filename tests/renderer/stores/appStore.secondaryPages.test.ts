import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore, type AppState } from '../../../src/renderer/stores/appStore';
import {
  SECONDARY_PAGE_SHOW_EXCLUSIONS,
  SECONDARY_PAGES_CLOSED,
} from '../../../src/renderer/stores/secondaryPages';

type SecondaryPageKey = keyof typeof SECONDARY_PAGES_CLOSED;

const SECONDARY_PAGE_KEYS = Object.keys(SECONDARY_PAGES_CLOSED) as SecondaryPageKey[];

const OPENERS: Array<{
  key: SecondaryPageKey;
  label: string;
  open: () => void;
  expected: boolean | string;
}> = [
  {
    key: 'showPromptManager',
    label: '提示词管理',
    open: () => useAppStore.getState().setShowPromptManager(true),
    expected: true,
  },
  {
    key: 'showActivityPanel',
    label: '活动',
    open: () => useAppStore.getState().setShowActivityPanel(true),
    expected: true,
  },
  {
    key: 'showTimeCapabilityCenter',
    label: '时间能力',
    open: () => useAppStore.getState().setShowTimeCapabilityCenter(true),
    expected: true,
  },
  {
    key: 'showDesktopPanel',
    label: '桌面状态',
    open: () => useAppStore.getState().setShowDesktopPanel(true),
    expected: true,
  },
  {
    key: 'showLab',
    label: '实验室',
    open: () => useAppStore.getState().setShowLab(true),
    expected: true,
  },
  {
    key: 'showLibraryPanel',
    label: '资料库',
    open: () => useAppStore.getState().setShowLibraryPanel(true),
    expected: true,
  },
  {
    key: 'showCapabilityHub',
    label: '能力中心',
    open: () => useAppStore.getState().openCapabilityHub('experts'),
    expected: true,
  },
  {
    key: 'showCronCenter',
    label: '自动化',
    open: () => useAppStore.getState().setShowCronCenter(true),
    expected: true,
  },
  {
    key: 'showLocalOpsPanel',
    label: '本机操作',
    open: () => useAppStore.getState().openLocalOpsPanel('desktop'),
    expected: true,
  },
  {
    key: 'showEvalCenter',
    label: '评测中心',
    open: () => useAppStore.getState().openEvalCenter(),
    expected: true,
  },
  {
    key: 'showProjectCollaborationPage',
    label: 'Neo 协同',
    open: () => useAppStore.getState().openProjectCollaborationPage('project-1'),
    expected: true,
  },
  {
    key: 'showProjectSpacePage',
    label: '协作空间',
    open: () => useAppStore.getState().openProjectSpacePage(),
    expected: true,
  },
  {
    key: 'expertDetailRoleId',
    label: '专家详情',
    open: () => useAppStore.getState().openExpertRoleDetail('researcher'),
    expected: 'researcher',
  },
];

function openEverySecondaryPage(): void {
  const opened = Object.fromEntries(
    SECONDARY_PAGE_KEYS.map((key) => [key, key === 'expertDetailRoleId' ? 'stale-role' : true]),
  ) as Partial<AppState>;
  useAppStore.setState(opened);
}

function expectOnlyPageOpen(activeKey: SecondaryPageKey, activeValue: unknown): void {
  const state = useAppStore.getState();
  for (const key of SECONDARY_PAGE_KEYS) {
    expect(
      state[key],
      `${String(key)} should be closed when ${String(activeKey)} opens`,
    ).toEqual(key === activeKey ? activeValue : SECONDARY_PAGES_CLOSED[key]);
  }
}

function booleanShowKeys(state: Record<string, unknown>): string[] {
  return Object.keys(state).filter((key) => key.startsWith('show') && typeof state[key] === 'boolean');
}

function secondaryPageRegistryMismatches(state: Record<string, unknown>): {
  missing: string[];
  extra: string[];
} {
  const excluded = new Set<string>(SECONDARY_PAGE_SHOW_EXCLUSIONS);
  const appStoreSecondaryShowKeys = booleanShowKeys(state).filter((key) => !excluded.has(key));
  const registeredSecondaryShowKeys = Object.keys(SECONDARY_PAGES_CLOSED).filter((key) => key.startsWith('show'));
  return {
    missing: appStoreSecondaryShowKeys.filter((key) => !registeredSecondaryShowKeys.includes(key)),
    extra: registeredSecondaryShowKeys.filter((key) => !appStoreSecondaryShowKeys.includes(key)),
  };
}

function assertSecondaryPageRegistry(state: Record<string, unknown>): void {
  const { missing, extra } = secondaryPageRegistryMismatches(state);
  const errors = [];
  if (missing.length > 0) errors.push(`SECONDARY_PAGES_CLOSED 漏了键：${missing.join(', ')}`);
  if (extra.length > 0) errors.push(`SECONDARY_PAGES_CLOSED 多了键：${extra.join(', ')}`);
  if (!Object.prototype.hasOwnProperty.call(SECONDARY_PAGES_CLOSED, 'expertDetailRoleId')) {
    errors.push('SECONDARY_PAGES_CLOSED 漏了键：expertDetailRoleId');
  }
  if (errors.length > 0) throw new Error(errors.join('；'));
}

describe('appStore 二级页互斥注册面', () => {
  beforeEach(() => {
    useAppStore.setState(SECONDARY_PAGES_CLOSED);
  });

  it.each(OPENERS)('$label 打开时关闭其他全部二级页', ({ key, open, expected }) => {
    openEverySecondaryPage();
    open();
    expectOnlyPageOpen(key, expected);
  });

  it('closeSecondaryPages 会按注册面关闭全部页面', () => {
    openEverySecondaryPage();
    useAppStore.getState().closeSecondaryPages();
    expectOnlyPageOpen('expertDetailRoleId', SECONDARY_PAGES_CLOSED.expertDetailRoleId);
  });

  it('对账 appStore 的整窗 show* 键与 SECONDARY_PAGES_CLOSED', () => {
    assertSecondaryPageRegistry(useAppStore.getState() as unknown as Record<string, unknown>);
  });

  it('对账测试能把新增但未登记的 show* 键喂红，并点名漏项', () => {
    const mutatedState = {
      ...useAppStore.getState(),
      showUnregisteredSecondaryPage: false,
    } as unknown as Record<string, unknown>;

    expect(() => assertSecondaryPageRegistry(mutatedState)).toThrowError(
      /SECONDARY_PAGES_CLOSED 漏了键：showUnregisteredSecondaryPage/,
    );
  });
});
