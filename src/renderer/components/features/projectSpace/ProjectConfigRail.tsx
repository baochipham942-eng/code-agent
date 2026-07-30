// ============================================================================
// ProjectConfigRail —— 项目协作空间右栏（专家/技能/连接器/自动化四 tab + 成员 tab 位）。
// 形态（批P 返工第二波）：「协作空间配置」标题行取消，顶部横滑 tab 条（共享壳
// RailTabShell）+ tab 内容拿全高；已选/可选同屏（弹窗形态废弃）。收起钮并在 tab 条
// 右端——两态同住右栏顶右角，不换位置（2026-07-27 房规）。
// 成员 tab 仅云空间显示：成员内容在 p1-c0-ui 分支，本分支只留 tab 位语义——
// 调用方经 membersContent 注入时才出现第五个 tab，本分支无人注入、tab 不渲染。
// 数据模型各走既有通道：
// - 专家：detail.roles 已选；rolesClient.listRoles() 可选；add/removeProjectRole 后刷新 detail
// - 连接器：project capability selections（kind='connector'）；可选项与能力中心「连接器」页
//   同源——connector 域 listNativeInventory（产品意义连接器：飞书/GitHub 等），不混 MCP 工具型 server
// - 技能：SKILL IPC 覆盖模型（projectOverride===true 已选），store 按工作目录隔离——
//   读写一律显式传 project.workspacePath；项目有工作目录即可增删，无目录只读 + hint
// - 自动化：cron agent 任务的 action.libraryProjectId===projectId 已选；updateJob 设置/清除
// 收起态写 localStorage('projectSpace.configRailCollapsed')。
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, PanelRightClose, PanelRightOpen, Plug, Sparkles, Users, UsersRound } from 'lucide-react';
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
import { describeSkillIpcError, invokeSkillIPC, invokeSkillIPCOrThrow } from '../../../services/invokeSkillIPC';
import { toast } from '../../../hooks/useToast';
import { formatNextRun } from '../../../utils/formatNextRun';
import { localeForLanguage } from '../../../utils/i18nTime';
import { IconButton } from '../../primitives/IconButton';
import { RailTabShell, type RailTabItem } from '../../composites/RailTabShell';
import { ProjectConfigTabPanel } from './ProjectConfigTabPanel';

export interface ProjectConfigRailProps {
  projectId: string;
  project: Project | null;
  detail: ProjectDetail | null;
  onRefreshDetail: () => void;
  /** 成员 tab 内容（仅云空间注入；本分支无人注入 = tab 位空着，不渲染） */
  membersContent?: React.ReactNode;
}

const COLLAPSE_STORAGE_KEY = 'projectSpace.configRailCollapsed';

type RailTabKey = 'experts' | 'skills' | 'connectors' | 'automation' | 'members';

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
  const [activeTab, setActiveTab] = useState<RailTabKey>('experts');
  // 专家可选项带展示层字段（displayName/description/icon）：可选列表两行项用 displayName
  const [roleOptions, setRoleOptions] = useState<Array<{ id: string; label: string; description?: string; icon?: string }>>([]);
  const [connectorSelections, setConnectorSelections] = useState<ProjectCapabilitySelection[]>([]);
  const [connectorCatalog, setConnectorCatalog] = useState<Array<{ id: string; label: string; description?: string }>>([]);
  const [skills, setSkills] = useState<SkillListEntry[]>([]);
  const [agentJobs, setAgentJobs] = useState<CronJobDefinition[]>([]);

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
  const handleSelectSkill = (name: string) => {
    void invokeSkillIPCOrThrow(SKILL_CHANNELS.SKILL_PROJECT_SET, name, true, skillWorkspacePath).then(loadSkills)
      .catch((error) => toast.error(describeSkillIpcError(error, ps.skillUpdateFailed)));
  };
  const handleUnselectSkill = (name: string) => {
    void invokeSkillIPCOrThrow(SKILL_CHANNELS.SKILL_PROJECT_CLEAR, name, skillWorkspacePath).then(loadSkills)
      .catch((error) => toast.error(describeSkillIpcError(error, ps.skillUpdateFailed)));
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

  const tabs: RailTabItem[] = [
    { id: 'experts', label: ps.cardExperts, icon: Users, testId: 'project-space-rail-tab-experts' },
    { id: 'skills', label: ps.cardSkills, icon: Sparkles, testId: 'project-space-rail-tab-skills' },
    { id: 'connectors', label: ps.cardConnectors, icon: Plug, testId: 'project-space-rail-tab-connectors' },
    { id: 'automation', label: ps.cardAutomation, icon: Clock, testId: 'project-space-rail-tab-automation' },
  ];
  // 成员 tab 位：仅调用方注入成员内容（云空间）时占位出现，本分支不注入
  if (membersContent) {
    tabs.push({ id: 'members', label: ps.cardMembers, icon: UsersRound, testId: 'project-space-rail-tab-members' });
  }
  const effectiveTab: RailTabKey = tabs.some((tab) => tab.id === activeTab) ? activeTab : 'experts';

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-zinc-800/70" data-testid="project-space-config-rail">
      <RailTabShell
        tabs={tabs}
        activeTabId={effectiveTab}
        onSelectTab={(id) => setActiveTab(id as RailTabKey)}
        ariaLabel={ps.configRailTitle}
        testId="project-space-config-rail-tabs"
        contentTestId="project-space-config-rail-content"
        trailing={(
          <IconButton
            size="sm"
            variant="ghost"
            icon={<PanelRightClose className="h-4 w-4" />}
            aria-label={ps.collapseRail}
            title={ps.collapseRail}
            data-testid="project-space-config-rail-collapse"
            onClick={toggleCollapsed}
          />
        )}
      >
        {effectiveTab === 'experts' && (
          <ProjectConfigTabPanel
            testId="project-space-rail-experts"
            removeLabel={ps.remove}
            selectedEmptyLabel={ps.selectedEmpty}
            optionsEmptyLabel={ps.pickerEmpty}
            searchPlaceholder={ps.pickerSearchPlaceholder}
            noMatchLabel={ps.pickerNoMatch}
            selected={expertSelected}
            options={expertOptions}
            onSelect={handleAddExpert}
            onRemove={handleRemoveExpert}
          />
        )}
        {effectiveTab === 'skills' && (
          <ProjectConfigTabPanel
            testId="project-space-rail-skills"
            removeLabel={ps.remove}
            selectedEmptyLabel={ps.selectedEmpty}
            optionsEmptyLabel={ps.pickerEmpty}
            searchPlaceholder={ps.pickerSearchPlaceholder}
            noMatchLabel={ps.pickerNoMatch}
            selected={skillSelected}
            options={skillOptions}
            onSelect={handleSelectSkill}
            onRemove={skillsEditable ? handleUnselectSkill : undefined}
            readOnlyHint={skillsEditable ? null : ps.skillsNoWorkspaceHint}
          />
        )}
        {effectiveTab === 'connectors' && (
          <ProjectConfigTabPanel
            testId="project-space-rail-connectors"
            removeLabel={ps.remove}
            selectedEmptyLabel={ps.selectedEmpty}
            optionsEmptyLabel={ps.pickerEmpty}
            searchPlaceholder={ps.pickerSearchPlaceholder}
            noMatchLabel={ps.pickerNoMatch}
            selected={connectorSelected}
            options={connectorOptions}
            onSelect={handleSelectConnector}
            onRemove={handleUnselectConnector}
          />
        )}
        {effectiveTab === 'automation' && (
          <ProjectConfigTabPanel
            testId="project-space-rail-automation"
            removeLabel={ps.remove}
            selectedEmptyLabel={ps.selectedEmpty}
            optionsEmptyLabel={ps.pickerEmpty}
            searchPlaceholder={ps.pickerSearchPlaceholder}
            noMatchLabel={ps.pickerNoMatch}
            selected={automationSelected}
            options={automationOptions}
            onSelect={handleSelectAutomation}
            onRemove={handleUnselectAutomation}
          />
        )}
        {effectiveTab === 'members' && membersContent}
      </RailTabShell>
    </aside>
  );
};

