// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LibrarySheet } from '../../../packages/mobile/src/features/sessions/LibrarySheet';
import { projectDisplayName, projectRowModels } from '../../../packages/mobile/src/features/sessions/projectRows';
import { messages } from '../../../packages/mobile/src/i18n';
import type { CompanionLibrary } from '../../../src/shared/contract/companionLibrary';

const text = messages('zh');
const key = (provider: string, model: string) => JSON.stringify([provider, model]);

// 列表第一项是手机上真实看到的 Kimi，电脑的默认是 deepseek（FB-141 的现场）
const library: CompanionLibrary = {
  nextOffset: null,
  projects: [{ id: 'one', name: 'One', canCreate: true }],
  sessions: [],
  models: [
    { provider: 'moonshot', model: 'kimi-k2.6', label: 'Kimi K2.6', providerLabel: 'Kimi' },
    { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek Chat', providerLabel: 'DeepSeek', isDefault: true },
  ],
};

function mount(overrides: Partial<CompanionLibrary> = {}, mode: 'projects' | 'projectSessions' | 'more' = 'projects', projectId: string | null = null, sessionId: string | null = null) {
  const manage = vi.fn(async () => {});
  const openProjectSessions = vi.fn();
  render(<LibrarySheet library={{ ...library, ...overrides }} sessionId={sessionId} text={text} busy={false} mode={mode}
    projectId={projectId} select={() => {}} loadMore={() => {}} manage={manage} openProjectSessions={openProjectSessions} />);
  return { manage, openProjectSessions, modelSelect: () => screen.getByLabelText(text.model) as HTMLSelectElement };
}

/** 项目会话前进页（主层 chevron 之后的那一页）。 */
function mountProjectSessions(overrides: Partial<CompanionLibrary> = {}, projectId = 'one', sessionId: string | null = null) {
  const mounted = mount(overrides, 'projectSessions', projectId, sessionId);
  return { ...mounted, select: mounted.modelSelect() };
}

describe('项目选择器主层（fix5-③：行=名称+副标题，会话在前进页不堆主层）', () => {
  afterEach(cleanup);

  it('同名项目用路径父一级消歧，独名项目不显示路径', () => {
    const withDup: Partial<CompanionLibrary> = {
      projects: [
        { id: 'a', name: 'workspace', canCreate: true, workspacePath: '/Users/neo/Downloads/ai/workspace' },
        { id: 'b', name: 'workspace', canCreate: true, workspacePath: '/private/tmp/neo-verify/workspace' },
        { id: 'c', name: '品牌提案', canCreate: true, workspacePath: '/Users/neo/Downloads/ai/brand' },
      ],
    };
    render(<LibrarySheet library={{ ...library, ...withDup }} sessionId={null} text={text} busy={false} mode="projects"
      projectId={null} select={() => {}} loadMore={() => {}} manage={vi.fn(async () => {})} openProjectSessions={() => {}} />);
    expect(screen.getByText('workspace · ~/Downloads/ai')).toBeTruthy();
    expect(screen.getByText('workspace · /private/tmp/neo-verify')).toBeTruthy();
    // 独名项目不出现消歧后缀——路径只在需要区分时才值得占一行宽度
    expect(screen.getByText('品牌提案')).toBeTruthy();
    expect(screen.queryByText('品牌提案 · ~/Downloads')).toBeNull();
  });

  it('最近有会话的项目标「最近使用 · N 个会话」，其余只给「N 个会话」', () => {
    const rows = projectRowModels(
      [{ id: 'a', name: 'A', canCreate: true }, { id: 'b', name: 'B', canCreate: true }],
      [
        { id: 's1', title: 't1', projectId: 'b', updatedAt: 2, archived: false, provider: 'deepseek', model: 'deepseek-chat' },
        { id: 's2', title: 't2', projectId: 'b', updatedAt: 1, archived: false, provider: 'deepseek', model: 'deepseek-chat' },
        { id: 's3', title: 't3', projectId: 'a', updatedAt: 0, archived: false, provider: 'deepseek', model: 'deepseek-chat' },
      ],
      { recent: n => `最近使用 · ${n} 个会话`, count: n => `${n} 个会话` },
    );
    expect(rows.find(row => row.id === 'b')!.subtitle).toBe('最近使用 · 2 个会话');
    expect(rows.find(row => row.id === 'a')!.subtitle).toBe('1 个会话');
  });

  it('主层一行 note 说明选中的含义，没有会话列表/新建表单', () => {
    mount();
    expect(screen.getByText(text.projectScopeNote)).toBeTruthy();
    expect(screen.queryByLabelText(text.sessionName)).toBeNull();
    expect(screen.queryByTestId('start-session')).toBeNull();
  });

  it('点项目 = 一步在所选项目起新会话（默认模型+默认名），不进前进页', () => {
    const { manage, openProjectSessions } = mount();
    fireEvent.click(screen.getByText('One'));
    expect(manage).toHaveBeenCalledWith('session.create',
      { title: text.newSession, provider: 'deepseek', model: 'deepseek-chat' }, 'project:one');
    expect(openProjectSessions).not.toHaveBeenCalled();
  });

  it('项目不能新建（无授权）时点项目进前进页继续已有工作，chevron 任何时候都进前进页', () => {
    const { openProjectSessions } = mount({ projects: [{ id: 'one', name: 'One', canCreate: false }] });
    fireEvent.click(screen.getByText('One'));
    expect(openProjectSessions).toHaveBeenCalledWith('one');
    cleanup();
    const second = mount();
    fireEvent.click(screen.getByLabelText(text.openProjectSessions));
    expect(second.openProjectSessions).toHaveBeenCalledWith('one');
  });

  // N-COMPANION-CANCREATE-SEMANTICS（build 45 真机：未分类没有工作目录，看起来完全正常、点了才失败）
  it('电脑上没设工作目录的项目：在点之前就置灰并说为什么，点了不建会话；已有会话仍能从前进页进', () => {
    const { manage, openProjectSessions } = mount({ projects: [
      { id: 'one', name: 'One', canCreate: true },
      { id: 'unsorted', name: '未分类', canCreate: false, createBlocked: 'no_workspace' },
    ] });
    const blocked = screen.getByTestId('project-unsorted');
    const main = blocked.querySelector('.project-main') as HTMLButtonElement;
    expect(main.disabled).toBe(true);
    expect(blocked.textContent).toContain(text.projectNoWorkspace);
    expect(screen.getByText(new RegExp(text.projectNoWorkspaceNote.replace('{name}', '未分类')))).toBeTruthy();
    fireEvent.click(main);
    expect(manage).not.toHaveBeenCalled();
    // 对照：能建的那行不置灰、不带原因
    const ok = screen.getByTestId('project-one');
    expect((ok.querySelector('.project-main') as HTMLButtonElement).disabled).toBe(false);
    expect(ok.textContent).not.toContain(text.projectNoWorkspace);
    fireEvent.click(blocked.querySelector('.project-more')!);
    expect(openProjectSessions).toHaveBeenCalledWith('unsorted');
    cleanup();
    // 前进页里也说同一个原因，不再拿「需要重新配对」冒充（那是没授权的原因）
    mount({ projects: [{ id: 'unsorted', name: '未分类', canCreate: false, createBlocked: 'no_workspace' }] }, 'projectSessions', 'unsorted');
    expect(screen.getByText(text.projectNoWorkspace)).toBeTruthy();
    expect(screen.queryByText(text.projectGrantRequired)).toBeNull();
    expect(screen.queryByTestId('start-session')).toBeNull();
  });
});

describe('项目会话前进页（projectSessions：继续已有工作或新建会话，带返回）', () => {
  afterEach(cleanup);

  const withSession: Partial<CompanionLibrary> = {
    sessions: [{ id: 's1', title: 'Talk', projectId: 'one', updatedAt: 1, archived: false, provider: 'deepseek', model: 'deepseek-chat' }],
  };

  it('列出项目里的会话，点选后返回原输入框', () => {
    const select = vi.fn();
    render(<LibrarySheet library={{ ...library, ...withSession }} sessionId={null} text={text} busy={false} mode="projectSessions"
      projectId="one" select={select} loadMore={() => {}} manage={vi.fn(async () => {})} openProjectSessions={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Talk' }));
    expect(select).toHaveBeenCalledWith('s1');
  });

  it('「会话名称」默认留空（placeholder 引导），不预填当前会话（上一会话 prompt 标题）的任何字', () => {
    // 爸真机现场：正开着一条被首条 prompt 命名的会话，进新建会话表单时名称被它的标题预填
    const withOldPromptTitle: Partial<CompanionLibrary> = {
      sessions: [{ id: 's1', title: '帮我把这三家的品牌资料整理一下', projectId: 'one', updatedAt: 1, archived: false, provider: 'deepseek', model: 'deepseek-chat' }],
    };
    mountProjectSessions(withOldPromptTitle, 'one', 's1');
    const input = screen.getByLabelText(text.sessionName) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe(text.sessionName);
    expect(screen.getByText(text.advancedOptions)).toBeTruthy();
  });

  it('一键新建用电脑默认模型；填了名称才用名称', () => {
    const { manage } = mountProjectSessions();
    fireEvent.click(screen.getByTestId('start-session'));
    expect(manage).toHaveBeenCalledWith('session.create',
      { title: text.newSession, provider: 'deepseek', model: 'deepseek-chat' }, 'project:one');
    fireEvent.change(screen.getByLabelText(text.sessionName), { target: { value: '品牌定位研究 ' } });
    fireEvent.click(screen.getByTestId('start-session'));
    expect(manage).toHaveBeenLastCalledWith('session.create',
      { title: '品牌定位研究', provider: 'deepseek', model: 'deepseek-chat' }, 'project:one');
  });

  it('项目不能新建时给重配对说明，不给新建入口', () => {
    mount({ projects: [{ id: 'one', name: 'One', canCreate: false }] }, 'projectSessions', 'one');
    expect(screen.getByText(text.projectGrantRequired)).toBeTruthy();
    expect(screen.queryByTestId('start-session')).toBeNull();
  });
});

describe('mobile model picker default', () => {
  afterEach(cleanup);

  it('preselects the computer default instead of the first list entry', () => {
    const { select } = mountProjectSessions();
    expect(select.value).toBe(key('deepseek', 'deepseek-chat'));
  });

  it('falls back to the first entry when the computer default is not selectable', () => {
    const { select } = mountProjectSessions({ models: library.models.map(({ isDefault: _drop, ...model }) => model) });
    expect(select.value).toBe(key('moonshot', 'kimi-k2.6'));
  });
});

/** 消歧标签的路径判定经 projectDisplayName（MobileRoot 前进页标题也走它）覆盖。 */
describe('同名消歧标签的路径判定', () => {
  const projects = (path: string) => [
    { id: 'a', name: 'workspace', canCreate: true, workspacePath: path },
    { id: 'b', name: 'workspace', canCreate: true, workspacePath: '/other/workspace' },
  ];
  it('取父目录一级；/Users/<name> 折叠为 ~', () => {
    expect(projectDisplayName(projects('/Users/neo/Downloads/ai/workspace')[0], projects('/Users/neo/Downloads/ai/workspace'))).toBe('workspace · ~/Downloads/ai');
    expect(projectDisplayName(projects('/private/tmp/neo-verify/workspace')[0], projects('/private/tmp/neo-verify/workspace'))).toBe('workspace · /private/tmp/neo-verify');
  });
  it('超长从中间截断，长度封顶', () => {
    const deep = projects('/Users/neo/Downloads/ai/some/very/deeply/nested/dir/workspace');
    const label = projectDisplayName(deep[0], deep);
    expect(label).toBe('workspace · ~/Downloads/…/nested/dir');
    expect(label.length).toBeLessThanOrEqual('workspace · '.length + 24);
  });
});

describe('选择会话模型是独立一屏，入口只留输入区胶囊（N-MOBILE-SESSIONSHEET-SPLIT，爸 2026-09-16 拍板）', () => {
  afterEach(cleanup);

  // 爸 2026-09-12/09-16 真机：会话实为 custom-glm-coding/glm-5.3-flash（电脑上没配 key），
  // 「会话操作」里却给它配了「使用此模型」——明知用不了的选项配了确认键。
  const offListSession = {
    sessions: [{ id: 's1', title: '用一句话说明 cowork 是什么', projectId: 'one',
      provider: 'custom-glm-coding', model: 'glm-5.3-flash' }],
  } as unknown as Partial<CompanionLibrary>;

  function mountMode(mode: 'more' | 'model', overrides: Partial<CompanionLibrary> = offListSession) {
    const manage = vi.fn(async () => {});
    render(<LibrarySheet library={{ ...library, ...overrides }} sessionId="s1" text={text} busy={false} mode={mode}
      projectId={null} select={() => {}} loadMore={() => {}} manage={manage} openProjectSessions={() => {}} />);
    return { manage };
  }

  it('会话操作弹窗里不再有模型：没有模型标签、没有下拉、没有「使用」键', () => {
    mountMode('more');
    // 前提自证：弹窗确实渲染出了会话操作本身
    expect(screen.getByText(text.rename)).toBeTruthy();
    expect(screen.queryByLabelText(text.model)).toBeNull();
    expect(document.querySelector('select')).toBeNull();
    expect(document.querySelector('.model-row')).toBeNull();
  });

  it('只列电脑已配置的模型；会话此刻用的那个没配时照实列出、置灰、点了什么都不发', () => {
    const { manage } = mountMode('model');
    const unconfigured = screen.getByTestId('model-unconfigured');
    expect(unconfigured.textContent).toContain('glm-5.3-flash');
    expect(unconfigured.textContent).toContain(text.modelNotConfigured);
    expect(unconfigured.getAttribute('aria-disabled')).toBe('true');
    // 它不是按钮：没有可点的「使用」入口
    expect(unconfigured.tagName).not.toBe('BUTTON');
    fireEvent.click(unconfigured);
    expect(manage).not.toHaveBeenCalled();
    // 可选项正好是电脑配置的那几个
    expect(document.querySelectorAll('button.model-row')).toHaveLength(library.models.length);
  });

  it('点一个已配置的模型就切过去；点当前那个不重复提交', () => {
    const inList = { sessions: [{ id: 's1', title: 'x', projectId: 'one', provider: 'deepseek', model: 'deepseek-chat' }] } as unknown as Partial<CompanionLibrary>;
    const { manage } = mountMode('model', inList);
    expect(screen.queryByTestId('model-unconfigured')).toBeNull();
    const current = screen.getByTestId('model-deepseek:deepseek-chat');
    expect(current.getAttribute('aria-current')).toBe('true');
    fireEvent.click(current);
    expect(manage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('model-moonshot:kimi-k2.6'));
    expect(manage).toHaveBeenCalledWith('session.model', { provider: 'moonshot', model: 'kimi-k2.6' });
  });

  it('电脑上最近调用失败的模型标出来，别让刚被拒的人又换到它身上', () => {
    mountMode('model', { ...offListSession, models: [
      { provider: 'custom-team-relay', model: 'LongCat-2.0', label: 'LongCat 2.0', providerLabel: 'Team Relay', isDefault: true, recentlyFailed: true },
      { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek Chat', providerLabel: 'DeepSeek' },
    ] });
    expect(screen.getByTestId('model-custom-team-relay:LongCat-2.0').textContent).toContain(text.modelRecentlyFailed);
    expect(screen.getByTestId('model-deepseek:deepseek-chat').textContent).toContain(text.modelConfigured);
    expect(screen.getByTestId('model-deepseek:deepseek-chat').textContent).not.toContain(text.modelRecentlyFailed);
  });

  it('未配置的只读项不许出现在「新建会话」那一档——那是可选项，不是当前项', () => {
    // grok ai-review Important：新建会话把「电脑上未配置」列进去等于让用户拿一个电脑上
    // 没配的模型去建会话，Host 会直接拒，界面只剩一句「电脑那边拒绝了这条操作」。
    mountProjectSessions(offListSession);
    expect(screen.queryByText(new RegExp(text.modelNotConfigured))).toBeNull();
    const select = screen.getByLabelText(text.model) as HTMLSelectElement;
    expect(select.value).toBe(key('deepseek', 'deepseek-chat'));
    fireEvent.click(screen.getByTestId('start-session'));
    // vi.fn manage 断言放 mount 返回值里——这里重挂后重新取
  });

});
