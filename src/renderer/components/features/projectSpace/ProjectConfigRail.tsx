// ============================================================================
// ProjectConfigRail —— 项目协作空间右栏「项目配置」（专家/技能/连接器/自动化四卡竖排，
// 云空间追加第五卡成员）。形态（批P 返工第四波①，爸 2026-07-30 拍板）：第二波 tab 化撤销，
// 退回第一波⑤的四卡形态——标题行 + 整卡可点开「添加」弹窗 + 已选 chips；弹窗带搜索框
// （名称+描述过滤）+ 两行列表项（名称+描述，空描述单行降级）+ 图标（专家有 icon）。
// 描述数据管线不丢：连接器=原生 i18n 介绍 + 货架 description；专家=displayName/description/icon；
// 技能=description；自动化=name+下次运行。成员卡经 membersContent 注入（仅云空间）。
// 数据模型各走既有通道：
// - 专家：detail.roles 已选；rolesClient.listRoles() 可选；add/removeProjectRole 后刷新 detail
// - 连接器：project capability selections（kind='connector'）；可选项=原生连接器 + 货架推荐 MCP
//   （爸 2026-07-30 拍板扩口径「飞书这些要进连接器」），不混基础工具型 server
// - 技能：SKILL IPC 覆盖模型（projectOverride===true 已选），store 按工作目录隔离——
//   读写一律显式传 project.workspacePath；项目有工作目录即可增删，无目录只读 + hint
// - 自动化：cron agent 任务的 action.libraryProjectId===projectId 已选；updateJob 设置/清除
// 收起态写 localStorage('projectSpace.configRailCollapsed')。
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { IPC_DOMAINS, type NativeConnectorInventoryItem } from '@shared/ipc';
import type { McpCatalogPayload } from '@shared/contract/mcpCatalog';
import { getBuiltinMcpCatalogPayload, mergeMcpCatalogWithBuiltinOfficialFeatured } from '@shared/constants/mcpCatalog';
import { SKILL_CHANNELS } from '@shared/ipc/channels';
import type { Project, ProjectCapabilitySelection, ProjectDetail } from '@shared/contract/project';
import type { CronJobDefinition } from '@shared/contract';
import { useI18n } from '../../../hooks/useI18n';
import * as projectClient from '../../../services/projectClient';
import * as rolesClient from '../../../services/rolesClient';
import { cronClient } from '../../../services/cronClient';
import ipcService from '../../../services/ipcService';
import { describeSkillIpcError, invokeSkillIPC, invokeSkillIPCOrThrow, isSkillFolderTrustError } from '../../../services/invokeSkillIPC';
import { FolderTrustDialog, type FolderTrustEvaluationView } from '../../FolderTrustDialog';
import { toast } from '../../../hooks/useToast';
import { formatNextRun } from '../../../utils/formatNextRun';
import { localeForLanguage } from '../../../utils/i18nTime';
import { IconButton } from '../../primitives/IconButton';
import { ProjectConfigCard } from './ProjectConfigCard';

export interface ProjectConfigRailProps {
  projectId: string;
  project: Project | null;
  detail: ProjectDetail | null;
  onRefreshDetail: () => void;
  /** 成员第五卡（仅云空间注入；不注入 = 四卡，不渲染成员卡位） */
  membersContent?: React.ReactNode;
}

const COLLAPSE_STORAGE_KEY = 'projectSpace.configRailCollapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

interface SkillListEntry {
  name: string;
  description?: string;
  projectOverride: boolean | null;
}

export const ProjectConfigRail: React.FC<ProjectConfigRailProps> = ({
  projectId,
  project,
  detail,
  onRefreshDetail,
  membersContent,
}) => {
  const { t, language } = useI18n();
  const ps = t.projectSpace;

  const [collapsed, setCollapsed] = useState(readCollapsed);
  // 专家可选项带展示层字段（displayName/description/icon/profession）：弹窗两行项与已选 chip 都用 displayName；
  // profession 真源=RolePanelEntry.profession（仅预设角色配置），缺省不显示职能段
  const [roleOptions, setRoleOptions] = useState<Array<{
    id: string;
    label: string;
    description?: string;
    icon?: string;
    profession?: string;
  }>>([]);
  const [connectorSelections, setConnectorSelections] = useState<ProjectCapabilitySelection[]>([]);
  const [connectorCatalog, setConnectorCatalog] = useState<Array<{ id: string; label: string; description?: string }>>([]);
  const [skills, setSkills] = useState<SkillListEntry[]>([]);
  const [agentJobs, setAgentJobs] = useState<CronJobDefinition[]>([]);
  // 信任门原地修复（爸 2026-07-30：不让用户跑去别处信任）：撞信任类错误 → toast 带「确认信任」
  // → 原地拉起既有 FolderTrustDialog 完整评估（禁自制简化版）→ 授权成功自动重放刚才那次操作。
  // 关键：信任目标是**本空间的工作目录**（folderTrust IPC 收 workingDirectory 参数），
  // 不是 app 当前工作目录——两者常常不同，信错目录等于没修。
  const [trustEvaluation, setTrustEvaluation] = useState<FolderTrustEvaluationView | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);
  const pendingTrustRetryRef = React.useRef<(() => Promise<void>) | null>(null);

  const toggleCollapsed = () => {
    setCollapsed((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // localStorage 不可用（隐私模式等）时退化为本次运行期内记忆
      }
      return next;
    });
  };

  const loadRoles = useCallback(() => {
    rolesClient.listRoles()
      .then((entries) => setRoleOptions(entries.map((entry) => ({
        id: entry.roleId,
        label: entry.displayName ?? entry.roleId,
        description: entry.description || undefined,
        icon: entry.icon,
        profession: entry.profession || undefined,
      }))))
      .catch(() => setRoleOptions([]));
  }, []);

  const nativeConnectorDescriptions = ps.nativeConnectorDescriptions as Record<string, string | undefined>;
  const loadConnectors = useCallback(() => {
    projectClient.listCapabilitySelections(projectId)
      .then((selections) => setConnectorSelections(selections.filter((item) => item.kind === 'connector')))
      .catch(() => setConnectorSelections([]));
    // 可选项 = 原生连接器 + 货架推荐 MCP（爸 2026-07-30 拍板扩口径「飞书这些要进连接器」）。
    // 货架走推荐目录（内置常量 + 云端目录合并，MCPSettings 同一套），自带名称/描述，
    // 与 getCatalog 直出「已配置 server 清单」不同——推荐目录是产品策展面，不混基础工具型条目的裸配置。
    const nativePromise = ipcService.invokeDomain<NativeConnectorInventoryItem[]>(IPC_DOMAINS.CONNECTOR, 'listNativeInventory')
      .then((items) => (Array.isArray(items) ? items : []).map((item) => ({
        id: item.id,
        label: item.label,
        description: nativeConnectorDescriptions[item.id],
      })))
      .catch(() => [] as Array<{ id: string; label: string; description?: string }>);
    const shelfPromise = ipcService.invokeDomain<McpCatalogPayload>(IPC_DOMAINS.MCP, 'getCatalog')
      .then((payload) => mergeMcpCatalogWithBuiltinOfficialFeatured(payload))
      .catch(() => getBuiltinMcpCatalogPayload());
    void Promise.all([nativePromise, shelfPromise]).then(([native, shelf]) => {
      const shelfItems = shelf.servers.map((server) => ({
        id: server.id,
        label: server.name,
        description: server.description,
      }));
      // id 撞车时原生优先（native 四件 id 是短词，货架 id 均带厂商前缀，实际不撞；防御性去重）
      const seen = new Set(native.map((item) => item.id));
      setConnectorCatalog([...native, ...shelfItems.filter((item) => !seen.has(item.id))]);
    });
  }, [projectId, nativeConnectorDescriptions]);

  const skillWorkspacePath = project?.workspacePath ?? undefined;
  const loadSkills = useCallback(() => {
    void invokeSkillIPC(SKILL_CHANNELS.SKILL_LIST, skillWorkspacePath).then((list) => {
      setSkills((list ?? []) as SkillListEntry[]);
    });
  }, [skillWorkspacePath]);

  const loadAgentJobs = useCallback(() => {
    cronClient.listJobs()
      .then((jobs) => setAgentJobs(jobs.filter((job) => job.action.type === 'agent')))
      .catch(() => setAgentJobs([]));
  }, []);

  useEffect(() => {
    loadRoles();
    loadConnectors();
    loadSkills();
    loadAgentJobs();
  }, [loadRoles, loadConnectors, loadSkills, loadAgentJobs]);

  // ---- 专家 ----
  const selectedRoleIds = useMemo(() => new Set((detail?.roles ?? []).map((link) => link.roleId)), [detail]);
  // 已选 chip 也用 displayName（roles 目录未加载到时回落裸 roleId）
  const expertSelected = (detail?.roles ?? []).map((link) => ({
    id: link.roleId,
    label: roleOptions.find((option) => option.id === link.roleId)?.label ?? link.roleId,
  }));
  const expertOptions = roleOptions.filter((option) => !selectedRoleIds.has(option.id));
  const handleAddExpert = (roleId: string) => {
    void projectClient.addProjectRole(projectId, roleId).then(onRefreshDetail).catch(() => undefined);
  };
  const handleRemoveExpert = (roleId: string) => {
    void projectClient.removeProjectRole(projectId, roleId).then(onRefreshDetail).catch(() => undefined);
  };

  // ---- 连接器 ----
  const selectedConnectorIds = useMemo(
    () => new Set(connectorSelections.map((item) => item.capabilityId)),
    [connectorSelections],
  );
  const connectorLabel = (capabilityId: string) => (
    connectorCatalog.find((option) => option.id === capabilityId)?.label ?? capabilityId
  );
  const connectorSelected = connectorSelections.map((item) => ({
    id: item.capabilityId,
    label: connectorLabel(item.capabilityId),
  }));
  const connectorOptions = connectorCatalog.filter((option) => !selectedConnectorIds.has(option.id));
  const handleSelectConnector = (capabilityId: string) => {
    void projectClient.selectCapability(projectId, 'connector', capabilityId).then(loadConnectors).catch(() => undefined);
  };
  const handleUnselectConnector = (capabilityId: string) => {
    void projectClient.unselectCapability(projectId, 'connector', capabilityId).then(loadConnectors).catch(() => undefined);
  };

  // ---- 技能（按项目工作目录隔离；有工作目录即可增删，无目录只读） ----
  const skillsEditable = Boolean(project?.workspacePath);
  const skillSelected = skills
    .filter((skill) => skill.projectOverride === true)
    .map((skill) => ({ id: skill.name, label: skill.name }));
  const skillOptions = skills
    .filter((skill) => skill.projectOverride !== true)
    .map((skill) => ({ id: skill.name, label: skill.name, description: skill.description || undefined }));
  // 技能增删共用出口：失败若属信任类，错误 toast 带「确认信任」动作并暂存重放闭包
  const runSkillOverride = (run: () => Promise<unknown>) => {
    void run().then(loadSkills).catch((error) => {
      if (isSkillFolderTrustError(error) && skillWorkspacePath) {
        pendingTrustRetryRef.current = async () => {
          await run();
          loadSkills();
        };
        toast.error(describeSkillIpcError(error, ps.skillUpdateFailed), {
          label: ps.trustConfirmAction,
          onClick: () => { void handleOpenTrustDialog(); },
        });
        return;
      }
      toast.error(describeSkillIpcError(error, ps.skillUpdateFailed));
    });
  };
  const handleSelectSkill = (name: string) => {
    runSkillOverride(() => invokeSkillIPCOrThrow(SKILL_CHANNELS.SKILL_PROJECT_SET, name, true, skillWorkspacePath));
  };
  const handleUnselectSkill = (name: string) => {
    runSkillOverride(() => invokeSkillIPCOrThrow(SKILL_CHANNELS.SKILL_PROJECT_CLEAR, name, skillWorkspacePath));
  };

  const runPendingTrustRetry = async () => {
    const retry = pendingTrustRetryRef.current;
    pendingTrustRetryRef.current = null;
    if (!retry) return;
    try {
      await retry();
    } catch (error) {
      toast.error(describeSkillIpcError(error, ps.skillUpdateFailed));
    }
  };
  const handleOpenTrustDialog = async () => {
    if (!skillWorkspacePath) return;
    try {
      const evaluation = await ipcService.invokeDomain<FolderTrustEvaluationView>(
        IPC_DOMAINS.FOLDER_TRUST,
        'get',
        { workingDirectory: skillWorkspacePath },
      );
      // 目录已被别处授权：不必再弹，直接重放
      if (evaluation.state === 'trusted') {
        await runPendingTrustRetry();
        return;
      }
      setTrustEvaluation(evaluation);
    } catch (error) {
      toast.error(describeSkillIpcError(error, ps.skillUpdateFailed));
    }
  };
  const handleTrustDecision = async (state: 'trusted' | 'blocked') => {
    if (!skillWorkspacePath) return;
    setTrustBusy(true);
    try {
      const evaluation = await ipcService.invokeDomain<FolderTrustEvaluationView>(
        IPC_DOMAINS.FOLDER_TRUST,
        'set',
        { state, decidedBy: 'project-space-rail', workingDirectory: skillWorkspacePath },
      );
      if (evaluation.state === 'trusted') {
        setTrustEvaluation(null);
        await runPendingTrustRetry();
      } else {
        setTrustEvaluation(evaluation);
      }
    } catch (error) {
      toast.error(describeSkillIpcError(error, ps.skillUpdateFailed));
    } finally {
      setTrustBusy(false);
    }
  };

  // ---- 自动化（cron agent 任务的 libraryProjectId） ----
  const automationSelected = agentJobs
    .filter((job) => job.action.type === 'agent' && job.action.libraryProjectId === projectId)
    .map((job) => ({ id: job.id, label: job.name }));
  const automationOptions = agentJobs
    .filter((job) => !(job.action.type === 'agent' && job.action.libraryProjectId === projectId))
    .map((job) => ({
      id: job.id,
      label: job.name,
      // 调度时间人话复用侧栏能力区 formatNextRun 样板（utils/formatNextRun），不重写
      description: job.nextRunAt != null
        ? ps.automationNextRun.replace('{time}', formatNextRun(job.nextRunAt, localeForLanguage(language)))
        : undefined,
    }));
  const handleSelectAutomation = (jobId: string) => {
    const job = agentJobs.find((item) => item.id === jobId);
    if (job?.action.type !== 'agent') return;
    void cronClient.updateJob(jobId, { action: { ...job.action, libraryProjectId: projectId } })
      .then(loadAgentJobs)
      .catch(() => undefined);
  };
  const handleUnselectAutomation = (jobId: string) => {
    const job = agentJobs.find((item) => item.id === jobId);
    if (job?.action.type !== 'agent') return;
    // host updateJob 是整体替换 action（{...definition, ...updates} 中 action 作为整值覆盖），
    // 省略 libraryProjectId 键即清除，无需设 'global' 占位
    const { libraryProjectId: _dropped, ...restAction } = job.action;
    void cronClient.updateJob(jobId, { action: restAction })
      .then(loadAgentJobs)
      .catch(() => undefined);
  };

  if (collapsed) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center border-l border-zinc-800/70" data-testid="project-space-config-rail-collapsed">
        {/* 两态同位（2026-07-27 房规）：展开钮与展开态 tab 条右端的收起钮同心——
            槽高对齐 tab 条实测高 37px 并垂直居中，探针实测两态按钮 top 差 ≤1px */}
        <div className="flex h-[37px] shrink-0 items-center">
          <IconButton
            size="sm"
            variant="ghost"
            icon={<PanelRightOpen className="h-4 w-4" />}
            aria-label={ps.expandRail}
            title={ps.expandRail}
            data-testid="project-space-config-rail-expand"
            onClick={toggleCollapsed}
          />
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-zinc-800/70" data-testid="project-space-config-rail">
      {/* 收起钮右缘与下方卡片「+」右缘同轴（批P 审美关，探针实测修前差 13px）：
          卡片「+」右缘 = 栏右缘 - 卡片网格 p-3(12) - 卡片边框(1) - 卡片 p-3(12) = 25，
          故本行右 padding 用 25px，不是与左侧对称的 px-3。 */}
      <div className="flex shrink-0 items-center gap-2 pl-3 pr-[25px] pt-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-300">{ps.configRailTitle}</h2>
        <IconButton
          size="sm"
          variant="ghost"
          icon={<PanelRightClose className="h-4 w-4" />}
          aria-label={ps.collapseRail}
          title={ps.collapseRail}
          data-testid="project-space-config-rail-collapse"
          onClick={toggleCollapsed}
        />
      </div>
      <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-3">
        <ProjectConfigCard
          testId="project-space-card-experts"
          title={ps.cardExperts}
          addLabel={ps.add}
          removeLabel={ps.remove}
          selectedEmptyLabel={ps.selectedEmpty}
          pickerEmptyLabel={ps.pickerEmpty}
          pickerSearchPlaceholder={ps.pickerSearchPlaceholder}
          pickerNoMatchLabel={ps.pickerNoMatch}
          selected={expertSelected}
          options={expertOptions}
          onSelect={handleAddExpert}
          onRemove={handleRemoveExpert}
          showOptionIcons
        />
        <ProjectConfigCard
          testId="project-space-card-skills"
          title={ps.cardSkills}
          addLabel={ps.add}
          removeLabel={ps.remove}
          selectedEmptyLabel={ps.selectedEmpty}
          pickerEmptyLabel={ps.pickerEmpty}
          pickerSearchPlaceholder={ps.pickerSearchPlaceholder}
          pickerNoMatchLabel={ps.pickerNoMatch}
          selected={skillSelected}
          options={skillOptions}
          onSelect={handleSelectSkill}
          onRemove={skillsEditable ? handleUnselectSkill : undefined}
          readOnlyHint={skillsEditable ? null : ps.skillsNoWorkspaceHint}
        />
        <ProjectConfigCard
          testId="project-space-card-connectors"
          title={ps.cardConnectors}
          addLabel={ps.add}
          removeLabel={ps.remove}
          selectedEmptyLabel={ps.selectedEmpty}
          pickerEmptyLabel={ps.pickerEmpty}
          pickerSearchPlaceholder={ps.pickerSearchPlaceholder}
          pickerNoMatchLabel={ps.pickerNoMatch}
          selected={connectorSelected}
          options={connectorOptions}
          onSelect={handleSelectConnector}
          onRemove={handleUnselectConnector}
        />
        <ProjectConfigCard
          testId="project-space-card-automation"
          title={ps.cardAutomation}
          addLabel={ps.add}
          removeLabel={ps.remove}
          selectedEmptyLabel={ps.selectedEmpty}
          pickerEmptyLabel={ps.pickerEmpty}
          pickerSearchPlaceholder={ps.pickerSearchPlaceholder}
          pickerNoMatchLabel={ps.pickerNoMatch}
          selected={automationSelected}
          options={automationOptions}
          onSelect={handleSelectAutomation}
          onRemove={handleUnselectAutomation}
        />
        {/* 成员第五卡：仅云空间注入（卡位语义与四卡一致，卡内「邀请」走页头同一 Modal） */}
        {membersContent}
      </div>
      {/* 信任确认：复用既有完整评估弹窗；requireDangerousItems=false —— 撞的是「未信任/失效」本身，
          零危险项也要给确认机会（与技能设置页同一档语义） */}
      <FolderTrustDialog
        evaluation={trustEvaluation}
        isBusy={trustBusy}
        requireDangerousItems={false}
        onTrust={() => { void handleTrustDecision('trusted'); }}
        onBlock={() => { void handleTrustDecision('blocked'); }}
        onOpenSettings={() => setTrustEvaluation(null)}
      />
    </aside>
  );
};
