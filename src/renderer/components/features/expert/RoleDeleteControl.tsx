// ============================================================================
// RoleDeleteControl - 用户自建角色的删除入口（N-ROLE-CREATE-DIRECT-DELETE）
//
// 二次确认（in-app ConfirmDialog，绝不用 window.confirm）→ deleteRole 移入回收站 →
// 带「撤销」动作的 toast（restoreDeletedRole 整份还原，30 天内有效）。
// 挂载门在 shouldMountRoleDeleteControl：只有用户自建角色显示。
// ============================================================================

import React, { useState } from "react";
import { IPC_DOMAINS } from "@shared/ipc";
import type { RolePanelDetail } from "@shared/contract/roleAssets";
import ipcService from "../../../services/ipcService";
import { useI18n } from "../../../hooks/useI18n";
import { useToastStore } from "../../../hooks/useToast";
import { useAppStore } from "../../../stores/appStore";
import { ConfirmDialog } from "../../composites/ConfirmDialog";
import { createLogger } from "../../../utils/logger";

const logger = createLogger("RoleDeleteControl");

/** 撤销窗口的 toast 存活时间：默认 4s 太短，够人反应过来点「撤销」 */
const UNDO_TOAST_MS = 8000;

/**
 * 挂载门：仅用户自建角色显示删除入口。
 * 内置/退役预设 → isBuiltin；装了角色包 → detail.restore 有值（还原出厂归角色包管）；
 * 孤儿（定义文件缺失）→ definition 为 null。这三种都不给删。
 */
export function shouldMountRoleDeleteControl(
  detail: Pick<RolePanelDetail, "isBuiltin" | "definition" | "restore">,
): boolean {
  return !detail.isBuiltin && detail.definition !== null && detail.restore === undefined;
}

export interface RoleDeleteControlProps {
  roleId: string;
  /** toast / 弹窗文案里展示的名字（花名优先，缺省 roleId） */
  displayName: string;
  /** 删除成功后离开详情页（回专家列表） */
  onDeleted: () => void;
  /** 撤销成功后重载详情 */
  onRestored: () => void;
  /** 详情页默认在撤销后重开；聊天完成卡留在原位恢复按钮即可。 */
  openDetailOnRestore?: boolean;
}

export const RoleDeleteControl: React.FC<RoleDeleteControlProps> = ({
  roleId,
  displayName,
  onDeleted,
  onRestored,
  openDetailOnRestore = true,
}) => {
  const { t } = useI18n();
  const text = t.expert.roleDetail;
  const addToast = useToastStore((state) => state.addToast);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
    setBusy(true);
    try {
      const { trashId } = await ipcService.invokeDomain<{ trashId: string }>(
        IPC_DOMAINS.ROLES,
        "deleteRole",
        { roleId },
      );
      setConfirming(false);
      onDeleted();
      // toast 的 action 闭包不依赖本组件存活：详情页已卸载，撤销仍可点
      addToast("success", text.deleteToast.replace("{role}", displayName), UNDO_TOAST_MS, {
        label: text.deleteUndo,
        onClick: () => {
          void (async () => {
            try {
              await ipcService.invokeDomain(IPC_DOMAINS.ROLES, "restoreDeletedRole", { trashId });
              addToast("success", text.restoreToast.replace("{role}", displayName));
              // 删除成功时 onDeleted 已离开详情页（组件卸载，onRestored 的 loadDetail 是
              // 死回调）：撤销后重新打开详情页 = 「undo reload the detail」，重挂载自带
              // 新数据；用户再关掉它时专家列表也会带着还原后的角色重挂载。
              if (openDetailOnRestore) useAppStore.getState().openExpertRoleDetail(roleId);
              onRestored();
            } catch (err) {
              // 过期被清 / 同名角色被重建：host 稳定 code 的 message 原样给人看
              addToast("error", err instanceof Error ? err.message : String(err));
              logger.error("Failed to restore deleted role", err);
            }
          })();
        },
      });
    } catch (err) {
      setConfirming(false);
      addToast("error", err instanceof Error ? err.message : String(err));
      logger.error("Failed to delete role", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button /* ds-allow:button: 页头紧凑的静默危险入口（btn-sm.danger：无底色、危险色文字），Button primitive 无此变体 */
        data-testid="role-delete"
        type="button"
        disabled={busy}
        onClick={() => setConfirming(true)}
        className="rounded px-2 py-1 text-xs text-badge-danger transition-colors hover:bg-red-900/40 disabled:opacity-50"
      >
        {text.deleteButton}
      </button>
      <ConfirmDialog
        isOpen={confirming}
        variant="danger"
        title={text.deleteDialogTitle}
        message={text.deleteDialogMessage.replace("{role}", displayName)}
        confirmText={text.deleteConfirm}
        cancelText={text.cancel}
        confirmDisabled={busy}
        onConfirm={() => void handleConfirm()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
};
