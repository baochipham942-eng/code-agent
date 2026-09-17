import { useState } from 'react';
import type { CompanionLibrary } from '../../../../../src/shared/contract/companionLibrary';
import type { messages } from '../../i18n';
import { AppIcon } from '../../app/AppIcon';
import { projectDisplayName, projectRowModels } from './projectRows';

export function LibrarySheet({ library, sessionId, text, busy, mode, projectId, select, manage, loadMore, openProjectSessions, pendingModel, onPickNewTaskModel }: {
  library: CompanionLibrary; sessionId: string | null; text: ReturnType<typeof messages>; busy: boolean;
  mode: 'projects' | 'projectSessions' | 'more' | 'model'; projectId: string | null;
  select(id: string): void; loadMore(): void; openProjectSessions(id: string): void;
  manage(action: 'session.create' | 'session.rename' | 'session.archive' | 'session.delete' | 'session.model', payload: Record<string, unknown>, target?: string): Promise<void>;
  /** 欢迎页（没选会话）正在用的新任务模型；点选只记在手机，不发 session.model。 */
  pendingModel?: { provider: string; model: string } | null;
  onPickNewTaskModel?(provider: string, model: string): void;
}) {
  const session = library.sessions.find(s => s.id === sessionId);
  const project = library.projects.find(p => p.id === projectId);
  // 新建会话的「会话名称」默认留空（fix5-③，2026-09-15 build 36 反馈⑦：被上一会话的 prompt
  // 标题预填，一键建出来的会话全叫上一个会话的名字）。重命名是另一回事：预填现名才对。
  const [newTitle, setNewTitle] = useState('');
  const [renameTitle, setRenameTitle] = useState(session?.title ?? '');
  const [deleting, setDeleting] = useState(false);
  // 新建会话一步起的默认模型：电脑默认 > 列表第一项（列表顺序不代表电脑的选择，FB-141）。
  const defaultModel = library.models.find(m => m.isDefault) ?? library.models[0];
  // 新建会话「高级选项」里的模型下拉：会话已有的模型 > 电脑的默认模型 > 列表第一项（列表顺序不代表电脑的选择）。
  const [modelKey, setModel] = useState(() => {
    const model = library.models.find(m => m.provider === session?.provider && m.model === session?.model) ?? defaultModel;
    return model ? JSON.stringify([model.provider, model.model]) : '';
  });
  const model = library.models.find(m => JSON.stringify([m.provider, m.model]) === modelKey);
  const rows = projectRowModels(library.projects, library.sessions, {
    recent: count => text.recentUseSessions.replace('{n}', String(count)),
    count: count => text.sessionsCount.replace('{n}', String(count)),
  });
  /**
   * 主层「点项目 = 选中并返回原输入框」（fix5-③，设计稿 project 屏的原则原文）：选中即在这
   * 项目里一步起会话——新任务用它的资料与工作范围，草稿由 activateDraft 带进新会话不丢。
   * 建不了（没有项目授权 / 电脑没配模型）就进项目会话前进页，那里能继续已有工作。
   */
  const selectProject = (target: CompanionLibrary['projects'][number]) => {
    if (target.canCreate && defaultModel) {
      void manage('session.create', { title: text.newSession, provider: defaultModel.provider, model: defaultModel.model }, `project:${target.id}`);
    } else openProjectSessions(target.id);
  };
  return <div className="library-sheet">
    {mode === 'projects' ? <>
      <div className="settings-group project-list">{rows.map(row => {
        const target = library.projects.find(p => p.id === row.id)!;
        // 电脑上没设工作目录 = 宿主必拒建会话：在点之前就置灰并说为什么（设计稿 projectUnavailable）。
        // 前进页照常能进——里面已有的会话是电脑上建的，打开它们不经过「新建」这条路。
        const noWorkspace = target.createBlocked === 'no_workspace';
        return <div className="project-row" key={row.id} data-testid={`project-${row.id}`} data-blocked={noWorkspace || undefined}>
          <button className="project-main" disabled={busy || noWorkspace} onClick={() => selectProject(target)}>
            <AppIcon name="folder" />
            <span className="flex"><p>{row.label}</p><span className="small">{noWorkspace ? text.projectNoWorkspace : row.subtitle}</span></span>
          </button>
          <button className="project-more" aria-label={text.openProjectSessions} disabled={busy} onClick={() => openProjectSessions(row.id)}><AppIcon name="chevron" /></button>
        </div>;
      })}</div>
      {!library.projects.length && <p>{text.projectGrantRequired}</p>}
      <p className="sheet-note">{text.projectScopeNote}{library.projects.filter(p => p.createBlocked === 'no_workspace')
        .map(p => text.projectNoWorkspaceNote.replace('{name}', projectDisplayName(p, library.projects))).join('')}</p>
    </> : mode === 'projectSessions' ? (project ? <>
      {project.canCreate ? <>
        <button className="primary" data-testid="start-session" disabled={busy || !model} onClick={() => model && void manage('session.create', { title: newTitle.trim() || text.newSession, provider: model.provider, model: model.model }, `project:${project.id}`)}>{text.newSession}</button>
        <details className="advanced">
          <summary>{text.advancedOptions}</summary>
          <label className="group-title" htmlFor="new-title">{text.sessionName}</label>
          <input id="new-title" value={newTitle} maxLength={160} placeholder={text.sessionName} onChange={e => setNewTitle(e.target.value)} />
          <label className="group-title" htmlFor="model-select">{text.model}</label>
          <select id="model-select" value={modelKey} disabled={busy} onChange={e => setModel(e.target.value)}>
            {library.models.map(m => <option key={JSON.stringify([m.provider, m.model])} value={JSON.stringify([m.provider, m.model])}>{m.providerLabel} · {m.label}</option>)}
          </select>
        </details>
      </> : <p>{project.createBlocked === 'no_workspace' ? text.projectNoWorkspace : text.projectGrantRequired}</p>}
      <p className="group-title">{text.recentSessions}</p>
      <div className="settings-group">{library.sessions.filter(s => s.projectId === project.id).map(s => <button className="settings-row" key={s.id} data-testid={`session-${s.id}`} data-session-id={s.id} disabled={busy} onClick={() => select(s.id)}>{s.title}{s.archived ? ` · ${text.archived}` : ''}</button>)}</div>
      {!library.sessions.some(s => s.projectId === project.id) && <p>{text.emptyHistory}</p>}
      {library.nextOffset != null && <button disabled={busy} onClick={loadMore}>{text.loadHistory}</button>}
    </> : <p>{text.projectUnavailable}</p>) : mode === 'model' ? (session ? (() => {
      /**
       * 选择会话模型（设计稿 model 屏；爸 2026-09-16 拍板：入口只留输入区胶囊）。只列电脑已配置的模型——
       * 列表由电脑侧 buildRuntimeModelOptions 产出，没配 key 的 provider 本来就不在里面。
       * 这条会话此刻会用的模型若不在列表里（电脑上没配），照实列出来、置灰、不给点：
       * 让用户看清「现在用的就是那个用不了的」，而不是给它配一个点了必失败的确认键（build 45 真机）。
       */
      const configured = library.models.some(m => m.provider === session.provider && m.model === session.model);
      return <>
        <div className="settings-group model-list">
          {!configured && <div className="settings-row model-row" aria-disabled="true" aria-current="true" data-testid="model-unconfigured">
            <span className="flex"><p>{session.model}</p><span className="small">{text.modelNotConfigured}</span></span><AppIcon name="check" />
          </div>}
          {library.models.map(m => {
            const current = m.provider === session.provider && m.model === session.model;
            return <button key={JSON.stringify([m.provider, m.model])} className="settings-row model-row" data-testid={`model-${m.provider}:${m.model}`}
              aria-current={current || undefined} disabled={busy}
              onClick={() => { if (!current) void manage('session.model', { provider: m.provider, model: m.model }); }}>
              <span className="flex"><p>{m.label}</p><span className="small">{m.providerLabel} · {m.recentlyFailed ? text.modelRecentlyFailed : text.modelConfigured}</span></span>
              {current && <AppIcon name="check" />}
            </button>;
          })}
        </div>
        {!library.models.length && <p>{text.modelUnavailable}</p>}
        <p className="sheet-note">{text.modelScopeNote}</p>
      </>;
    })() : pendingModel ? <>
      <div className="settings-group model-list">
        {library.models.map(m => {
          const current = m.provider === pendingModel.provider && m.model === pendingModel.model;
          return <button key={JSON.stringify([m.provider, m.model])} className="settings-row model-row" data-testid={`model-${m.provider}:${m.model}`}
            aria-current={current || undefined} disabled={busy}
            onClick={() => { if (!current) onPickNewTaskModel?.(m.provider, m.model); }}>
            <span className="flex"><p>{m.label}</p><span className="small">{m.providerLabel} · {m.recentlyFailed ? text.modelRecentlyFailed : text.modelConfigured}</span></span>
            {current && <AppIcon name="check" />}
          </button>;
        })}
      </div>
      {!library.models.length && <p>{text.modelUnavailable}</p>}
      <p className="sheet-note">{text.modelScopeNote}</p>
    </> : <p>{text.emptyHistory}</p>) : session ? <>
      <label className="group-title" htmlFor="session-title">{text.sessionName}</label>
      <input id="session-title" maxLength={160} value={renameTitle} onChange={e => setRenameTitle(e.target.value)} />
      <button className="primary" disabled={busy || !renameTitle.trim() || renameTitle.trim() === session.title} onClick={() => void manage('session.rename', { title: renameTitle.trim() })}>{text.rename}</button>
      <button className="settings-row" disabled={busy} onClick={() => void manage('session.archive', { archived: !session.archived })}>{session.archived ? text.unarchive : text.archive}</button>
      {deleting ? <div role="alert"><p>{text.deleteConfirmation}</p><button disabled={busy} onClick={() => setDeleting(false)}>{text.keepSession}</button><button className="danger" disabled={busy} onClick={() => void manage('session.delete', {})}>{text.confirmDelete}</button></div>
        : <button className="settings-row danger" disabled={busy} onClick={() => setDeleting(true)}>{text.deleteSession}</button>}
    </> : <p>{text.emptyHistory}</p>}
  </div>;
}
