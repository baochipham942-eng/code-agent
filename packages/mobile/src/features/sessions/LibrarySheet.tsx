import { useState } from 'react';
import type { CompanionLibrary } from '../../../../../src/shared/contract/companionLibrary';
import type { messages } from '../../i18n';
import { AppIcon } from '../../app/AppIcon';
import { projectRowModels } from './projectRows';

export function LibrarySheet({ library, sessionId, text, busy, mode, projectId, select, manage, loadMore, openProjectSessions }: {
  library: CompanionLibrary; sessionId: string | null; text: ReturnType<typeof messages>; busy: boolean;
  mode: 'projects' | 'projectSessions' | 'more'; projectId: string | null;
  select(id: string): void; loadMore(): void; openProjectSessions(id: string): void;
  manage(action: 'session.create' | 'session.rename' | 'session.archive' | 'session.delete' | 'session.model', payload: Record<string, unknown>, target?: string): Promise<void>;
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
  /**
   * 这条会话正在用的模型**可能不在列表里**：`library.models` 由电脑侧 buildRuntimeModelOptions
   * 产出，会剔掉没配 key 的 provider。查不到就退到列表第一项的话，下拉显示的是另一个**真实**
   * 模型名（不是「未知」），而紧挨着的「使用此模型」照样可点——用户以为在确认当前，一点就把
   * 会话换掉了（爸 2026-09-12 真机：会话实为 custom-glm-coding/glm-5.3-flash，下拉写着
   * DeepSeek V4.1 Flash）。所以给它补一条只读项，让下拉说真话、让那个按钮保持禁用。
   *
   * 只在「会话操作」这一档补：这条只读项的意思是「这条会话正在用的那个」，不是一个可选项。
   * 新建会话那两档把它列进去等于让用户拿一个电脑上没配的模型去建会话，Host 会直接拒
   * （grok ai-review Important）。
   */
  const options = mode === 'more' && session && !library.models.some(m => m.provider === session.provider && m.model === session.model)
    ? [...library.models, { provider: session.provider, model: session.model, label: session.model, providerLabel: text.modelNotConfigured }]
    : library.models;
  const [modelKey, setModel] = useState(() => {
    // 会话已有的模型 > 电脑的默认模型 > 列表第一项（列表顺序不代表电脑的选择）
    const model = options.find(m => m.provider === session?.provider && m.model === session?.model)
      ?? library.models.find(m => m.isDefault) ?? library.models[0];
    return model ? JSON.stringify([model.provider, model.model]) : '';
  });
  const model = options.find(m => JSON.stringify([m.provider, m.model]) === modelKey);
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
      <div className="settings-group project-list">{rows.map(row => <div className="project-row" key={row.id} data-testid={`project-${row.id}`}>
        <button className="project-main" disabled={busy} onClick={() => selectProject(library.projects.find(p => p.id === row.id)!)}>
          <AppIcon name="folder" />
          <span className="flex"><p>{row.label}</p><span className="small">{row.subtitle}</span></span>
        </button>
        <button className="project-more" aria-label={text.openProjectSessions} disabled={busy} onClick={() => openProjectSessions(row.id)}><AppIcon name="chevron" /></button>
      </div>)}</div>
      {!library.projects.length && <p>{text.projectGrantRequired}</p>}
      <p className="sheet-note">{text.projectScopeNote}</p>
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
      </> : <p>{text.projectGrantRequired}</p>}
      <p className="group-title">{text.recentSessions}</p>
      <div className="settings-group">{library.sessions.filter(s => s.projectId === project.id).map(s => <button className="settings-row" key={s.id} data-testid={`session-${s.id}`} data-session-id={s.id} disabled={busy} onClick={() => select(s.id)}>{s.title}{s.archived ? ` · ${text.archived}` : ''}</button>)}</div>
      {!library.sessions.some(s => s.projectId === project.id) && <p>{text.emptyHistory}</p>}
      {library.nextOffset != null && <button disabled={busy} onClick={loadMore}>{text.loadHistory}</button>}
    </> : <p>{text.projectUnavailable}</p>) : session ? <>
      <label className="group-title" htmlFor="session-title">{text.sessionName}</label>
      <input id="session-title" maxLength={160} value={renameTitle} onChange={e => setRenameTitle(e.target.value)} />
      <button className="primary" disabled={busy || !renameTitle.trim() || renameTitle.trim() === session.title} onClick={() => void manage('session.rename', { title: renameTitle.trim() })}>{text.rename}</button>
      <button className="settings-row" disabled={busy} onClick={() => void manage('session.archive', { archived: !session.archived })}>{session.archived ? text.unarchive : text.archive}</button>
      {deleting ? <div role="alert"><p>{text.deleteConfirmation}</p><button disabled={busy} onClick={() => setDeleting(false)}>{text.keepSession}</button><button className="danger" disabled={busy} onClick={() => void manage('session.delete', {})}>{text.confirmDelete}</button></div>
        : <button className="settings-row danger" disabled={busy} onClick={() => setDeleting(true)}>{text.deleteSession}</button>}
    </> : <p>{text.emptyHistory}</p>}
    {mode === 'more' && <>
      <label className="group-title" htmlFor="model-select">{text.model}</label>
      <select id="model-select" value={modelKey} disabled={busy} onChange={e => setModel(e.target.value)}>
        {options.map(m => <option key={JSON.stringify([m.provider, m.model])} value={JSON.stringify([m.provider, m.model])}>{m.providerLabel} · {m.label}</option>)}
      </select>
      {session && <button className="primary" disabled={busy || !model || (model.provider === session.provider && model.model === session.model)} onClick={() => model && void manage('session.model', { provider: model.provider, model: model.model })}>{text.useModel}</button>}
    </>}
  </div>;
}
