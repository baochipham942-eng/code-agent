// ============================================================================
// RoleMemoryActions - 角色记忆区的批量动作（导出全部 / 在 Finder 中显示）
// ============================================================================
// N-ROLE-MEMORY-EXPORT：详情页记忆区此前的粒度是逐条查看/编辑/删除，这里补上
// 两个目录级动作——导出走 host 汇成一份 Markdown 落「下载」文件夹（toast 报路径），
// 定位走 host 的 shell.showItemInFolder 打开角色记忆目录（web 模式无文件系统，隐藏）。

import React, { useState } from "react";
import { Download, FolderOpen } from "lucide-react";
import { IPC_DOMAINS } from "@shared/ipc";
import ipcService from "../../../services/ipcService";
import { useI18n } from "../../../hooks/useI18n";
import { toast } from "../../../hooks/useToast";
import { isWebMode } from "../../../utils/platform";
import { createLogger } from "../../../utils/logger";
import { Button } from "../../primitives/Button";

const logger = createLogger("RoleMemoryActions");

export interface RoleMemoryActionsProps {
  roleId: string;
  /** 当前记忆条数：0 时导出禁用并给提示（不写空文件） */
  memoryCount: number;
}

export const RoleMemoryActions: React.FC<RoleMemoryActionsProps> = ({ roleId, memoryCount }) => {
  const { t } = useI18n();
  const text = t.settings.roles.detail;
  const showToast = toast.show;
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const saved = await ipcService.invokeDomain<{ filePath: string }>(
        IPC_DOMAINS.ROLES,
        "exportMemories",
        { roleId },
      );
      showToast("success", text.memoriesExportDone.replace("{path}", saved.filePath));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("error", text.memoriesExportFailed.replace("{message}", message));
      logger.error("Failed to export role memories", err);
    } finally {
      setExporting(false);
    }
  };

  const handleReveal = async () => {
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.ROLES, "revealMemoryFolder", { roleId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast("error", text.memoriesRevealFolderFailed.replace("{message}", message));
      logger.error("Failed to reveal role memory folder", err);
    }
  };

  return (
    <div data-testid="role-memory-actions" className="mb-2 flex flex-wrap items-center gap-2">
      <Button
        data-testid="role-memory-export"
        size="sm"
        variant="secondary"
        leftIcon={<Download className="h-3.5 w-3.5" />}
        disabled={memoryCount === 0}
        loading={exporting}
        onClick={() => void handleExport()}
      >
        {text.memoriesExport}
      </Button>
      {memoryCount === 0 ? (
        <span data-testid="role-memory-export-hint" className="text-xs text-zinc-500">
          {text.memoriesExportEmptyHint}
        </span>
      ) : null}
      {isWebMode() ? null : (
        <Button
          data-testid="role-memory-reveal"
          size="sm"
          variant="ghost"
          leftIcon={<FolderOpen className="h-3.5 w-3.5" />}
          onClick={() => void handleReveal()}
        >
          {text.memoriesRevealFolder}
        </Button>
      )}
    </div>
  );
};
