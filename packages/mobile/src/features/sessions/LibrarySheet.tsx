import { useState } from 'react';
import type { CompanionLibrary } from '../../../../../src/shared/contract/companionLibrary';
import type { messages } from '../../i18n';
import { AppIcon } from '../../app/AppIcon';

export function LibrarySheet({ library, sessionId, text, busy, mode, select, manage, loadMore }: {
  library: CompanionLibrary; sessionId: string | null; text: ReturnType<typeof messages>; busy: boolean; mode: 'projects' | 'more';
  select(id: string): void; loadMore(): void;
  manage(action: 'session.create' | 'session.rename' | 'session.archive' | 'session.delete' | 'session.model', payload: Record<string, unknown>, target?: string): Promise<void>;
}) {
  const session = library.sessions.find(s => s.id === sessionId);
  const [projectId, setProject] = useState(session?.projectId ?? library.projects[0]?.id ?? '');
  const [title, setTitle] = useState(session?.title ?? '');
  const [deleting, setDeleting] = useState(false);
  const project = library.projects.find(p => p.id === projectId);
  /**
   * 这条会话正在用的模型**可能不在列表里**：`library.models` 由电脑侧 buildRuntimeModelOptions
   * 产出，会剔掉没配 key 的 provider。查不到就退到列表第一项的话，下拉显示的是另一个**真实**
   * 模型名（不是「未知」），而紧挨着的「使用此模型」照样可点——用户以为在确认当前，一点就把
   * 会话换掉了（爸 2026-09-12 真机：会话实为 custom-glm-coding/glm-5.3-flash，下拉写着
   * DeepSeek V4.1 Flash）。所以给它补一条只读项，让下拉说真话、让那个按钮保持禁用。
   */
  const options = session && !library.models.some(m => m.provider === session.provider && m.model === session.model)
    ? [...library.models, { provider: session.provider, model: session.model, label: session.model, providerLabel: text.modelNotConfigured }]
    : library.models;
  const [modelKey, setModel] = useState(() => {
    // 会话已有的模型 > 电脑的默认模型 > 列表第一项（列表顺序不代表电脑的选择）
    const model = options.find(m => m.provider === session?.provider && m.model === session?.model)
      ?? library.models.find(m => m.isDefault) ?? library.models[0];
    return model ? JSON.stringify([model.provider, model.model]) : '';
  });
  const model = options.find(m => JSON.stringify([m.provider, m.model]) === modelKey);
  return <div className="library-sheet">
    {mode === 'projects' ? <>
      <p className="caption">{text.authorizedProjects}</p>
      <div className="settings-group">{library.projects.map(p => <button key={p.id} className="settings-row" aria-pressed={p.id === projectId} onClick={() => setProject(p.id)}><span>{p.name}</span>{p.id === projectId && <AppIcon name="check" />}</button>)}</div>
      {!library.projects.length && <p>{text.projectGrantRequired}</p>}
      {project && <><h3>{project.name}</h3>
        <div className="settings-group">{library.sessions.filter(s => s.projectId === projectId).map(s => <button className="settings-row" key={s.id} disabled={busy} onClick={() => select(s.id)}>{s.title}{s.archived ? ` · ${text.archived}` : ''}</button>)}</div>
        {!library.sessions.some(s => s.projectId === projectId) && <p>{text.emptyHistory}</p>}
        {project.canCreate ? <>
          <label className="group-title" htmlFor="new-title">{text.newSession}</label>
          <input id="new-title" value={title} maxLength={160} placeholder={text.sessionName} onChange={e => setTitle(e.target.value)} />
          <button className="primary" disabled={busy || !model} onClick={() => model && void manage('session.create', { title: title.trim() || text.newSession, provider: model.provider, model: model.model }, `project:${project.id}`)}>{text.newSession}</button>
        </> : <p>{text.projectGrantRequired}</p>}
      </>}
    </> : session ? <>
      <label className="group-title" htmlFor="session-title">{text.sessionName}</label>
      <input id="session-title" maxLength={160} value={title} onChange={e => setTitle(e.target.value)} />
      <button className="primary" disabled={busy || !title.trim() || title.trim() === session.title} onClick={() => void manage('session.rename', { title: title.trim() })}>{text.rename}</button>
      <button className="settings-row" disabled={busy} onClick={() => void manage('session.archive', { archived: !session.archived })}>{session.archived ? text.unarchive : text.archive}</button>
      {deleting ? <div role="alert"><p>{text.deleteConfirmation}</p><button disabled={busy} onClick={() => setDeleting(false)}>{text.keepSession}</button><button className="danger" disabled={busy} onClick={() => void manage('session.delete', {})}>{text.confirmDelete}</button></div>
        : <button className="settings-row danger" disabled={busy} onClick={() => setDeleting(true)}>{text.deleteSession}</button>}
    </> : <p>{text.emptyHistory}</p>}
    {library.nextOffset != null && <button disabled={busy} onClick={loadMore}>{text.loadHistory}</button>}
    <label className="group-title" htmlFor="model-select">{text.model}</label>
    <select id="model-select" value={modelKey} disabled={busy} onChange={e => setModel(e.target.value)}>
      {options.map(m => <option key={JSON.stringify([m.provider, m.model])} value={JSON.stringify([m.provider, m.model])}>{m.providerLabel} · {m.label}</option>)}
    </select>
    {mode === 'more' && session && <button className="primary" disabled={busy || !model || (model.provider === session.provider && model.model === session.model)} onClick={() => model && void manage('session.model', { provider: model.provider, model: model.model })}>{text.useModel}</button>}
  </div>;
}
