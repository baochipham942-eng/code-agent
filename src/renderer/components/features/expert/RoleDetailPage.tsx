// ============================================================================
// RoleDetailPage - 角色详情（设置页与专家面板共用）
// ============================================================================

import React, { useCallback, useEffect, useState } from "react";
import {
  AlarmClock,
  ArrowLeft,
  Check,
  FileText,
  History,
  MessageSquarePlus,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { IPC_DOMAINS } from "@shared/ipc";
import type {
  RolePanelDetail,
  RolePanelMemory,
  RoleBoundCronJob,
  RoleProactivityLevel,
  RoleVisual,
} from "@shared/contract/roleAssets";
import type { CronScheduleConfig } from "@shared/contract/cron";
import type { SkillCategory } from "@shared/contract/skillRepository";
import ipcService from "../../../services/ipcService";
import { createLogger } from "../../../utils/logger";
import { startEditRoleChat } from "../../../utils/startEditRoleChat";
import { useI18n } from "../../../hooks/useI18n";
import { RoleIcon } from "../shared/RoleIcon";
import { SettingsDetails, SettingsSection } from "../settings/SettingsLayout";
import { RoleBindingsSection } from "../settings/tabs/RoleBindingsSection";
import { useAppStore } from "../../../stores/appStore";

const logger = createLogger("RoleDetailPage");

async function fetchRoleDetail(roleId: string): Promise<RolePanelDetail> {
  return ipcService.invokeDomain<RolePanelDetail>(IPC_DOMAINS.ROLES, "detail", {
    roleId,
  });
}

async function fetchBoundCronJobs(roleId: string): Promise<RoleBoundCronJob[]> {
  return ipcService.invokeDomain<RoleBoundCronJob[]>(IPC_DOMAINS.ROLES, "listBoundCronJobs", { roleId });
}

async function deleteRoleMemory(
  roleId: string,
  filename: string,
): Promise<void> {
  await ipcService.invokeDomain(IPC_DOMAINS.ROLES, "deleteMemory", {
    roleId,
    filename,
  });
}

async function updateRoleMemory(
  roleId: string,
  memory: RolePanelMemory,
): Promise<void> {
  await ipcService.invokeDomain(IPC_DOMAINS.ROLES, "updateMemory", {
    roleId,
    filename: memory.filename,
    name: memory.name,
    description: memory.description,
    content: memory.content,
  });
}

async function setRoleProactivity(
  roleId: string,
  level: RoleProactivityLevel,
): Promise<void> {
  await ipcService.invokeDomain(IPC_DOMAINS.ROLES, "setProactivity", {
    roleId,
    level,
  });
}

async function updateRoleVisual(roleId: string, visual: RoleVisual): Promise<RoleVisual> {
  return ipcService.invokeDomain<RoleVisual>(IPC_DOMAINS.ROLES, "updateVisual", { roleId, visual });
}

type Equipment = NonNullable<RolePanelDetail["equipment"]>;

async function updateRoleEquipment(roleId: string, equipment: Pick<Equipment, "skills" | "tools" | "model" | "maxIterations">): Promise<void> {
  await ipcService.invokeDomain(IPC_DOMAINS.ROLES, "updateEquipment", { roleId, equipment });
}

async function updateRoleDefinitionBody(roleId: string, body: string): Promise<void> {
  await ipcService.invokeDomain(IPC_DOMAINS.ROLES, "updateDefinitionBody", { roleId, body });
}

async function restoreRoleFactory(roleId: string): Promise<void> {
  await ipcService.invokeDomain(IPC_DOMAINS.ROLES, "restoreFactory", { roleId });
}

function definitionBody(definition: string | null): string {
  const match = definition?.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return match?.[1] ?? "";
}

function formatAutomationSchedule(schedule: CronScheduleConfig, text: ReturnType<typeof useI18n>["t"]["expert"]["roleDetail"]): string {
  if (schedule.type === "every") {
    return text.automationEvery.replace("{interval}", String(schedule.interval)).replace("{unit}", text.automationUnits[schedule.unit]);
  }
  if (schedule.type === "at") {
    const timestamp = typeof schedule.datetime === "number" ? schedule.datetime : Date.parse(schedule.datetime);
    const time = Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : String(schedule.datetime);
    return text.automationAt.replace("{time}", time);
  }
  return text.automationCron.replace("{expression}", schedule.timezone ? `${schedule.expression} · ${schedule.timezone}` : schedule.expression);
}

const BoundAutomationsSection: React.FC<{ jobs?: RoleBoundCronJob[] }> = ({ jobs = [] }) => {
  const { t } = useI18n();
  const text = t.expert.roleDetail;
  const setShowCronCenter = useAppStore((state) => state.setShowCronCenter);
  return <SettingsSection title={text.automationsTitle} description={text.automationsDescription}>
    {jobs.length === 0 ? <div data-testid="role-bound-automations-empty" className="rounded-lg border border-dashed border-zinc-700/70 p-4 text-center text-xs text-zinc-500">{text.automationsEmpty}</div> : <div className="space-y-2" data-testid="role-bound-automations-list">
      {jobs.map((job) => {
        const nextRun = job.nextRunAt ? text.automationNextRun.replace("{time}", new Date(job.nextRunAt).toLocaleString()) : text.automationNoNextRun;
        return <div key={job.id} data-testid={`role-bound-automation-${job.id}`} className="rounded-lg border border-zinc-700/60 bg-zinc-900/40 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0"><div className="truncate text-sm text-zinc-200">{job.name}</div><div className="mt-1 text-xs text-zinc-500">{formatAutomationSchedule(job.schedule, text)} · {nextRun}</div></div>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]"><span className={`rounded px-1.5 py-0.5 ${job.enabled ? "bg-emerald-500/10 text-emerald-300" : "bg-zinc-700/60 text-zinc-400"}`}>{job.enabled ? text.automationStatusEnabled : text.automationStatusDisabled}</span><span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-violet-200">{job.actionType === "agent" ? text.automationTypeAgent : text.automationTypeRoleWake}</span></div>
          </div>
          {job.actionType === "role_wake" ? <p data-testid={`role-bound-automation-managed-${job.id}`} className="mt-2 text-xs text-amber-200/80">{text.automationRoleWakeManaged}</p> : null}
          <button /* ds-allow:button: 详情行跳转自动化面板需保持紧凑文字动作 */ type="button" onClick={() => setShowCronCenter(true)} className="mt-2 text-xs text-violet-300 hover:text-violet-200">{text.automationOpenPanel}</button>
        </div>;
      })}
    </div>}
  </SettingsSection>;
};

const EquipmentEditor: React.FC<{ roleId: string; equipment: Equipment; onSaved: () => void }> = ({ roleId, equipment, onSaved }) => {
  const { t } = useI18n();
  const text = t.expert.roleDetail;
  const [draft, setDraft] = useState(() => ({ skills: equipment.skills, tools: equipment.tools, model: equipment.model, maxIterations: equipment.maxIterations }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft({ skills: equipment.skills, tools: equipment.tools, model: equipment.model, maxIterations: equipment.maxIterations }), [equipment]);
  const toggle = (key: "skills" | "tools", value: string) => setDraft((current) => ({ ...current, [key]: current[key].includes(value) ? current[key].filter((item) => item !== value) : [...current[key], value] }));
  const save = async () => {
    setBusy(true); setError(null);
    try { await updateRoleEquipment(roleId, draft); onSaved(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  return <SettingsSection title="装备" description="从当前机器真实可用的技能和工具中选择，避免写入无效名称。">
    <div data-testid="role-equipment-editor" className="space-y-4">
      <label className="block space-y-1 text-xs text-zinc-400"><span>{text.modelTier}</span><select data-testid="role-equipment-model" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value as Equipment["model"] })} className="w-full rounded border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 text-sm text-zinc-200"><option value="fast">fast</option><option value="balanced">balanced</option><option value="powerful">powerful</option></select></label>
      <label className="block space-y-1 text-xs text-zinc-400"><span>{text.maxIterations}</span><input data-testid="role-equipment-max-iterations" type="number" min={1} max={200} value={draft.maxIterations} onChange={(event) => setDraft({ ...draft, maxIterations: Math.max(1, Math.min(200, Number(event.target.value) || 1)) })} className="w-full rounded border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 text-sm text-zinc-200" /></label>
      <fieldset><legend className="mb-1 text-xs text-zinc-400">{text.skills}</legend><div className="grid max-h-40 grid-cols-2 gap-1 overflow-auto rounded border border-zinc-800 p-2">{equipment.availableSkills.map((skill) => <label key={skill} className="flex items-center gap-1.5 text-xs text-zinc-300"><input type="checkbox" checked={draft.skills.includes(skill)} onChange={() => toggle("skills", skill)} />{skill}</label>)}</div></fieldset>
      <fieldset><legend className="mb-1 text-xs text-zinc-400">{text.tools}</legend><div className="grid max-h-48 grid-cols-2 gap-1 overflow-auto rounded border border-zinc-800 p-2">{equipment.availableTools.map((tool) => <label key={tool} className="flex items-center gap-1.5 text-xs text-zinc-300"><input type="checkbox" checked={draft.tools.includes(tool)} onChange={() => toggle("tools", tool)} />{tool}</label>)}</div></fieldset>
      <button /* ds-allow:button: 装备表单的紧凑保存按钮，Button primitive 会改变布局 */ data-testid="role-equipment-save" type="button" disabled={busy} onClick={() => void save()} className="rounded bg-emerald-500/20 px-3 py-1.5 text-xs text-emerald-200 disabled:opacity-50">{busy ? "保存中…" : "保存装备"}</button>
      {error ? <div className="text-xs text-red-400">{error}</div> : null}
    </div>
  </SettingsSection>;
};

const DefinitionEditor: React.FC<{ roleId: string; definition: string | null; restore?: RolePanelDetail["restore"]; onSaved: () => void }> = ({ roleId, definition, restore, onSaved }) => {
  const { t } = useI18n();
  const text = t.expert.roleDetail;
  const [body, setBody] = useState(() => definitionBody(definition));
  const [busy, setBusy] = useState(false);
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setBody(definitionBody(definition)), [definition]);
  const save = async () => { setBusy(true); setError(null); try { await updateRoleDefinitionBody(roleId, body); onSaved(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); } };
  const restoreFactory = async () => { setBusy(true); setError(null); try { await restoreRoleFactory(roleId); setConfirmingRestore(false); onSaved(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); } };
  return <SettingsSection title="人设正文" description="直接编辑专家的人设；保存只会替换正文，不会改动 frontmatter。">
    <div data-testid="role-definition-editor" className="space-y-3">
      <textarea data-testid="role-definition-body" value={body} onChange={(event) => setBody(event.target.value)} rows={14} disabled={!definition} className="w-full rounded border border-zinc-700 bg-zinc-950/70 p-2 font-mono text-xs text-zinc-200 focus:outline-none" />
      <div className="flex flex-wrap items-center gap-2"><button /* ds-allow:button: 人设正文保存的紧凑按钮，primitive 会改变布局 */ data-testid="role-definition-save" type="button" disabled={busy || !definition} onClick={() => void save()} className="rounded bg-emerald-500/20 px-3 py-1.5 text-xs text-emerald-200 disabled:opacity-50">{text.saveDefinition}</button>
        {restore ? (confirmingRestore ? <><span className="text-xs text-amber-200">{text.restoreWarning}</span><button /* ds-allow:button: 还原确认需紧凑危险操作样式 */ data-testid="role-restore-confirm" type="button" disabled={busy || !restore.available} onClick={() => void restoreFactory()} className="rounded bg-red-900/50 px-2 py-1 text-xs text-red-200 disabled:opacity-50">{text.confirmRestore}</button><button /* ds-allow:button: 还原取消为紧凑文本按钮 */ type="button" onClick={() => setConfirmingRestore(false)} className="px-2 py-1 text-xs text-zinc-400">{text.cancel}</button></> : <button /* ds-allow:button: 还原出厂是紧凑破坏性操作，primitive 会改变布局 */ data-testid="role-restore-factory" type="button" disabled={!restore.available || busy} title={restore.disabledReason} onClick={() => setConfirmingRestore(true)} className="rounded border border-amber-700/60 px-3 py-1.5 text-xs text-amber-200 disabled:opacity-50">{text.restoreFactory}</button>) : null}
      </div>
      {error ? <div className="text-xs text-red-400">{error}</div> : null}
    </div>
  </SettingsSection>;
};

const CATEGORY_IDS: SkillCategory[] = [
  "docs-office", "data-analysis", "design-creative", "content-marketing",
  "product", "research", "automation", "development",
];
const ICON_NAMES = ["Microscope", "BarChart3", "FileText", "Palette", "Megaphone", "Zap", "Wrench"];

const VisualEditor: React.FC<{
  roleId: string;
  detail: RolePanelDetail;
  onSaved: () => void;
}> = ({ roleId, detail, onSaved }) => {
  const { t } = useI18n();
  const text = t.expert.visual;
  const [visual, setVisual] = useState<RoleVisual>(detail.visual);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setVisual(detail.visual), [detail.visual]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateRoleVisual(roleId, {
        ...visual,
        displayName: visual.displayName?.trim(),
        profession: visual.profession?.trim(),
        tags: (visual.tags ?? []).map((value) => value.trim()).filter(Boolean),
        quickPrompts: (visual.quickPrompts ?? []).map((value) => value.trim()).filter(Boolean),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      logger.error("Failed to update role visual", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={text.title} description={text.description}>
      {/* E6-3 接入 locallyModified 前，内置角色统一提示：这里拿不到角色包的本地修改状态。 */}
      {detail.isBuiltin ? <p className="mb-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{text.builtinNotice}</p> : null}
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-xs text-zinc-400">
          <span>{text.displayName}</span>
          <input value={visual.displayName ?? ""} onChange={(event) => setVisual({ ...visual, displayName: event.target.value })} className="w-full rounded border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none" />
        </label>
        <label className="space-y-1 text-xs text-zinc-400">
          <span>{text.profession}</span>
          <input value={visual.profession ?? ""} onChange={(event) => setVisual({ ...visual, profession: event.target.value })} className="w-full rounded border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none" />
        </label>
        <label className="space-y-1 text-xs text-zinc-400">
          <span>{text.category}</span>
          <select value={visual.category ?? ""} onChange={(event) => setVisual({ ...visual, category: (event.target.value || undefined) as SkillCategory | undefined })} className="w-full rounded border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none">
            <option value="">—</option>
            {CATEGORY_IDS.map((category) => <option key={category} value={category}>{text.categories[category]}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs text-zinc-400">
          <span>{text.icon}</span>
          <select value={visual.icon ?? ""} onChange={(event) => setVisual({ ...visual, icon: event.target.value || undefined })} className="w-full rounded border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none">
            <option value="">—</option>
            {ICON_NAMES.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs text-zinc-400">
          <span>{text.tags}</span>
          <textarea value={(visual.tags ?? []).join("\n")} onChange={(event) => setVisual({ ...visual, tags: event.target.value.split("\n") })} placeholder={text.tagsHint} rows={3} className="w-full rounded border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none" />
        </label>
        <label className="space-y-1 text-xs text-zinc-400">
          <span>{text.quickPrompts}</span>
          <textarea value={(visual.quickPrompts ?? []).join("\n")} onChange={(event) => setVisual({ ...visual, quickPrompts: event.target.value.split("\n") })} placeholder={text.quickPromptsHint} rows={3} className="w-full rounded border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none" />
        </label>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button /* ds-allow:button: 基本信息保存是紧凑的表单提交按钮，当前 Button primitive 会改变布局 */ type="button" disabled={busy} onClick={() => void save()} className="rounded bg-emerald-500/20 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50">{busy ? text.saving : text.save}</button>
        {error ? <span className="text-xs text-red-400">{error}</span> : null}
      </div>
    </SettingsSection>
  );
};

interface MemoryRowProps {
  roleId: string;
  memory: RolePanelMemory;
  onChanged: () => void;
}

const MemoryRow: React.FC<MemoryRowProps> = ({ roleId, memory, onChanged }) => {
  const { t } = useI18n();
  const roleText = t.settings.roles;
  const commonText = t.common;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(memory.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteRoleMemory(roleId, memory.filename);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      logger.error("Failed to delete role memory", err);
    } finally {
      setBusy(false);
      setConfirmingDelete(false);
    }
  };

  const handleSaveEdit = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateRoleMemory(roleId, { ...memory, content: editContent });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      logger.error("Failed to update role memory", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-zinc-200">{memory.name}</div>
          <div className="mt-0.5 text-xs text-zinc-500">
            {memory.description}
          </div>
          <div className="mt-0.5 text-[10px] text-zinc-600">
            {memory.filename}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!editing && !confirmingDelete ? (
            <>
              <button /* ds-allow:button: 记忆编辑图标按钮 p-1.5，primitive 变体会改变尺寸与外观 */
                type="button"
                title={commonText.edit}
                onClick={() => setEditing(true)}
                className="rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-700/60 hover:text-zinc-200"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button /* ds-allow:button: 记忆删除图标按钮 p-1.5（hover 红），primitive 变体会改变尺寸 */
                type="button"
                title={commonText.delete}
                onClick={() => setConfirmingDelete(true)}
                className="rounded p-1.5 text-zinc-400 transition-colors hover:bg-red-900/40 hover:text-red-400"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          ) : null}
          {confirmingDelete ? (
            <>
              <span className="text-xs text-red-400">
                {roleText.confirmDeleteQuestion}
              </span>
              <button /* ds-allow:button: 删除确认按钮，自定义小尺寸弱化红（bg-red-900/50），与 danger 变体实心红不同 */
                type="button"
                disabled={busy}
                onClick={handleDelete}
                className="rounded bg-red-900/50 px-2 py-1 text-xs text-red-300 hover:bg-red-900/80 disabled:opacity-50"
              >
                {commonText.delete}
              </button>
              <button /* ds-allow:button: 删除取消按钮，自定义小尺寸无背景文本按钮，primitive 变体会强加 padding/bg */
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700/60"
              >
                {commonText.cancel}
              </button>
            </>
          ) : null}
        </div>
      </div>
      {editing ? (
        <div className="mt-2 space-y-2">
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            rows={6}
            className="w-full rounded border border-zinc-600 bg-zinc-950/80 p-2 font-mono text-xs text-zinc-300 focus:border-zinc-400 focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button /* ds-allow:button: 记忆保存按钮，自定义小尺寸（px-2.5 py-1 text-xs），primitive 最小 sm 仍更大 */
              type="button"
              disabled={busy}
              onClick={handleSaveEdit}
              className="flex items-center gap-1 rounded bg-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-600 disabled:opacity-50"
            >
              <Check className="h-3 w-3" /> {commonText.save}
            </button>
            <button /* ds-allow:button: 记忆编辑取消按钮，自定义小尺寸无背景文本按钮，primitive 变体会强加 padding/bg */
              type="button"
              onClick={() => {
                setEditing(false);
                setEditContent(memory.content);
              }}
              className="flex items-center gap-1 rounded px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-700/60"
            >
              <X className="h-3 w-3" /> {commonText.cancel}
            </button>
          </div>
        </div>
      ) : (
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-zinc-950/60 p-2 text-xs text-zinc-400">
          {memory.content}
        </pre>
      )}
      {error ? <div className="mt-2 text-xs text-red-400">{error}</div> : null}
    </div>
  );
};

const PROACTIVITY_LEVELS: RoleProactivityLevel[] = [
  "silent",
  "daily",
  "realtime",
];

const ProactivitySelector: React.FC<{
  roleId: string;
  current: RoleProactivityLevel;
  onChanged: () => void;
}> = ({ roleId, current, onChanged }) => {
  const { t } = useI18n();
  const optionsText = t.settings.roles.proactivity.options;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleSelect = async (level: RoleProactivityLevel) => {
    if (level === current || busy) return;
    setBusy(true);
    setError(null);
    try {
      await setRoleProactivity(roleId, level);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      logger.error("Failed to set role proactivity", err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      {PROACTIVITY_LEVELS.map((level) => {
        const option = optionsText[level];
        const selected = level === current;
        return (
          <button /* ds-allow:button: 主动性等级单选卡，全宽左对齐含单选圈+多行，primitive 居中变体不兼容 */
            key={
              level
            }
            type="button"
            disabled={busy}
            onClick={() => void handleSelect(level)}
            className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${selected ? "border-emerald-600/70 bg-emerald-900/20" : "border-zinc-700/70 bg-zinc-900/40 hover:border-zinc-500"} ${busy ? "opacity-60" : ""}`}
          >
            <div
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${selected ? "border-emerald-500" : "border-zinc-600"}`}
            >
              {selected ? (
                <div className="h-2 w-2 rounded-full bg-emerald-500" />
              ) : null}
            </div>
            <div className="min-w-0">
              <div
                className={`text-sm ${selected ? "text-emerald-300" : "text-zinc-300"}`}
              >
                {option.label}
              </div>
              <div className="mt-0.5 text-xs text-zinc-500">{option.hint}</div>
            </div>
          </button>
        );
      })}
      {error ? <div className="text-xs text-red-400">{error}</div> : null}
    </div>
  );
};

export interface RoleDetailPageProps {
  roleId: string;
  icon?: string;
  onBack: () => void;
  backLabel?: string;
  onVisualUpdated?: () => void;
}

export const RoleDetailPage: React.FC<RoleDetailPageProps> = ({
  roleId,
  icon,
  onBack,
  backLabel,
  onVisualUpdated,
}) => {
  const { t } = useI18n();
  const roleText = t.settings.roles;
  const expertText = t.expert;
  const [detail, setDetail] = useState<RolePanelDetail | null>(null);
  const [boundCronJobs, setBoundCronJobs] = useState<RoleBoundCronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextDetail, jobs] = await Promise.all([fetchRoleDetail(roleId), fetchBoundCronJobs(roleId)]);
      setDetail(nextDetail);
      setBoundCronJobs(jobs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      logger.error("Failed to load role detail", err);
    } finally {
      setLoading(false);
    }
  }, [roleId]);
  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);
  return (
    <div className="space-y-5" data-testid={`role-detail-page-${roleId}`}>
      <button /* ds-allow:button: 返回链接式按钮，纯文本+图标无背景，primitive 变体会强加 bg/padding */
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
      >
        <ArrowLeft className="h-3.5 w-3.5" />{" "}
        {backLabel ?? roleText.detail.backToList}
      </button>
      <header className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800 text-zinc-300">
          <RoleIcon name={detail?.visual.icon ?? icon} className="h-7 w-7" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-medium text-zinc-200">{detail?.visual.displayName || roleId}</h3>
          <p className="text-xs text-zinc-500">{detail?.visual.profession || roleText.detail.subtitle}</p>
        </div>
        <button /* ds-allow:button: 对话式修改入口，emerald 语义色弱化胶囊，primitive 无对应变体 */
          type="button"
          onClick={() => void startEditRoleChat(roleId)}
          title={roleText.detail.editByChatTitle}
          className="flex shrink-0 items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-1 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/25"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          {roleText.detail.editByChat}
        </button>
      </header>
      {loading ? (
        <div className="text-sm text-zinc-500">{roleText.loading}</div>
      ) : null}
      {error ? <div className="text-sm text-red-400">{error}</div> : null}
      {detail ? (
        <>
          <VisualEditor roleId={roleId} detail={detail} onSaved={() => { void loadDetail(); onVisualUpdated?.(); }} />
          {detail.locallyModified ? <p data-testid="role-locally-modified" className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{expertText.visual.builtinNotice}</p> : null}
          {detail.equipment ? <EquipmentEditor roleId={roleId} equipment={detail.equipment} onSaved={loadDetail} /> : null}
          <DefinitionEditor roleId={roleId} definition={detail.definition} restore={detail.restore} onSaved={loadDetail} />
          <SettingsSection
            title={roleText.detail.proactivityTitle}
            description={roleText.detail.proactivityDescription}
          >
            <div className="flex items-start gap-2">
              <AlarmClock className="mt-1 h-4 w-4 shrink-0 text-zinc-500" />
              <div className="min-w-0 flex-1">
                <ProactivitySelector
                  roleId={roleId}
                  current={detail.proactivity?.level ?? "silent"}
                  onChanged={loadDetail}
                />
              </div>
            </div>
          </SettingsSection>
          <BoundAutomationsSection jobs={boundCronJobs} />
          <RoleBindingsSection roleId={roleId} />
          <SettingsSection
            title={`${roleText.detail.memoriesTitlePrefix}${detail.memories.length}${roleText.detail.memoriesTitleSuffix}`}
            description={roleText.detail.memoriesDescription}
          >
            {detail.memories.length === 0 ? (
              <div className="rounded-lg border border-dashed border-zinc-700/70 p-4 text-center text-xs text-zinc-500">
                {roleText.detail.memoriesEmpty}
              </div>
            ) : (
              <div className="space-y-2">
                {detail.memories.map((memory) => (
                  <MemoryRow
                    key={memory.filename}
                    roleId={roleId}
                    memory={memory}
                    onChanged={loadDetail}
                  />
                ))}
              </div>
            )}
          </SettingsSection>
          <SettingsSection
            title={roleText.detail.historyTitle}
            description={roleText.detail.historyDescription}
          >
            {detail.history.length === 0 ? (
              <div className="rounded-lg border border-dashed border-zinc-700/70 p-4 text-center text-xs text-zinc-500">
                {roleText.detail.historyEmpty}
              </div>
            ) : (
              <ul className="space-y-1 rounded-lg border border-zinc-700/60 bg-zinc-900/40 p-3">
                {[...detail.history].reverse().map((line, index) => (
                  <li
                    key={index}
                    className="flex items-start gap-2 text-xs text-zinc-400"
                  >
                    <History className="mt-0.5 h-3 w-3 shrink-0 text-zinc-600" />
                    <span>{line.replace(/^- /, "")}</span>
                  </li>
                ))}
              </ul>
            )}
          </SettingsSection>
          <SettingsDetails
            title={roleText.detail.definitionTitle}
            description={
              detail.definition
                ? `${roleText.detail.definitionDescriptionPrefix}${detail.definitionPath}`
                : roleText.detail.definitionMissingDescription
            }
          >
            {detail.definition ? (
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-zinc-950/60 p-3 font-mono text-xs text-zinc-400">
                {detail.definition}
              </pre>
            ) : (
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <FileText className="h-3.5 w-3.5" />
                {roleText.detail.definitionMissingPrefix}
                {detail.definitionPath}
                {roleText.detail.definitionMissingSuffix}
              </div>
            )}
          </SettingsDetails>
        </>
      ) : null}
    </div>
  );
};
