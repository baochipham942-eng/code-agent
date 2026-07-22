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
  RoleProactivityLevel,
} from "@shared/contract/roleAssets";
import ipcService from "../../../services/ipcService";
import { createLogger } from "../../../utils/logger";
import { startEditRoleChat } from "../../../utils/startEditRoleChat";
import { useI18n } from "../../../hooks/useI18n";
import { RoleIcon } from "../shared/RoleIcon";
import { SettingsDetails, SettingsSection } from "../settings/SettingsLayout";
import { RoleBindingsSection } from "../settings/tabs/RoleBindingsSection";

const logger = createLogger("RoleDetailPage");

async function fetchRoleDetail(roleId: string): Promise<RolePanelDetail> {
  return ipcService.invokeDomain<RolePanelDetail>(IPC_DOMAINS.ROLES, "detail", {
    roleId,
  });
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
}

export const RoleDetailPage: React.FC<RoleDetailPageProps> = ({
  roleId,
  icon,
  onBack,
  backLabel,
}) => {
  const { t } = useI18n();
  const roleText = t.settings.roles;
  const [detail, setDetail] = useState<RolePanelDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await fetchRoleDetail(roleId));
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
          <RoleIcon name={icon} className="h-7 w-7" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-medium text-zinc-200">{roleId}</h3>
          <p className="text-xs text-zinc-500">{roleText.detail.subtitle}</p>
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
