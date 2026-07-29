// ============================================================================
// ProjectConfigRail —— 项目协作空间右栏「项目配置」（专家/技能/连接器/自动化四卡）。
// 数据模型各走既有通道：
// - 专家：detail.roles 已选；rolesClient.listRoles() 可选；add/removeProjectRole 后刷新 detail
// - 连接器：project capability selections（kind='connector'）；可选项 MCP getCatalog
// - 技能：SKILL IPC 覆盖模型（projectOverride===true 已选），store 按当前工作目录隔离——
//   仅当项目 workspacePath 等于当前会话工作目录时可增删，否则只读 + hint
// - 自动化：cron agent 任务的 action.libraryProjectId===projectId 已选；updateJob 设置/清除
// 收起态写 localStorage('projectSpace.configRailCollapsed')。
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import { SKILL_CHANNELS } from '@shared/ipc/channels';
import type { Project, ProjectCapabilitySelection, ProjectDetail } from '@shared/contract/project';
import type { McpCatalogPayload } from '@shared/contract/mcpCatalog';
import type { CronJobDefinition } from '@shared/contract';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';
import * as projectClient from '../../../services/projectClient';
import * as rolesClient from '../../../services/rolesClient';
import { cronClient } from '../../../services/cronClient';
import { invokeSkillIPC, invokeSkillIPCOrThrow } from '../../../services/invokeSkillIPC';
import { IconButton } from '../../primitives/IconButton';
import { ProjectConfigCard } from './ProjectConfigCard';

export interface ProjectConfigRailProps {
  projectId: string;
  project: Project | null;
  detail: ProjectDetail | null;
  onRefreshDetail: () => void;
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
}) => {
  const { t } = useI18n();
  const ps = t.projectSpace;
  const openCapabilityHub = useAppStore((state) => state.openCapabilityHub);
  const setShowCronCenter = useAppStore((state) => state.setShowCronCenter);
  const appWorkingDirectory = useAppStore((state) => state.workingDirectory);
  const sessionWorkingDirectory = useSessionStore((state) => {
    const current = state.sessions.find((session) => session.id === state.currentSessionId);
    return current?.workingDirectory ?? null;
  });
  const currentWorkingDirectory = sessionWorkingDirectory ?? appWorkingDirectory;

  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [roleOptions, setRoleOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [connectorSelections, setConnectorSelections] = useState<ProjectCapabilitySelection[]>([]);
  const [connectorCatalog, setConnectorCatalog] = useState<Array<{ id: string; label: string }>>([]);
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
      .then((entries) => setRoleOptions(entries.map((entry) => ({ id: entry.roleId, label: entry.roleId }))))
      .catch(() => setRoleOptions([]));
  }, []);

  const loadConnectors = useCallback(() => {
    projectClient.listCapabilitySelections(projectId)
      .then((selections) => setConnectorSelections(selections.filter((item) => item.kind === 'connector')))
      .catch(() => setConnectorSelections([]));
    void window.domainAPI?.invoke<McpCatalogPayload>(IPC_DOMAINS.MCP, 'getCatalog')
      .then((result) => {
        if (result?.success && result.data) {
          setConnectorCatalog(result.data.servers.map((server) => ({ id: server.id, label: server.name })));
        }
      })
      .catch(() => setConnectorCatalog([]));
  }, [projectId]);

  const loadSkills = useCallback(() => {
    void invokeSkillIPC(SKILL_CHANNELS.SKILL_LIST).then((list) => {
      setSkills((list ?? []) as SkillListEntry[]);
    });
  }, []);

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
  const expertSelected = (detail?.roles ?? []).map((link) => ({ id: link.roleId, label: link.roleId }));
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

  // ---- 技能（按当前工作目录隔离；非本项目工作目录只读） ----
  const skillsEditable = Boolean(project?.workspacePath) && project?.workspacePath === currentWorkingDirectory;
  const skillSelected = skills
    .filter((skill) => skill.projectOverride === true)
    .map((skill) => ({ id: skill.name, label: skill.name }));
  const skillOptions = skills
    .filter((skill) => skill.projectOverride !== true)
    .map((skill) => ({ id: skill.name, label: skill.name }));
  const handleSelectSkill = (name: string) => {
    void invokeSkillIPCOrThrow(SKILL_CHANNELS.SKILL_PROJECT_SET, name, true).then(loadSkills).catch(() => undefined);
  };
  const handleUnselectSkill = (name: string) => {
    void invokeSkillIPCOrThrow(SKILL_CHANNELS.SKILL_PROJECT_CLEAR, name).then(loadSkills).catch(() => undefined);
  };

  // ---- 自动化（cron agent 任务的 libraryProjectId） ----
  const automationSelected = agentJobs
    .filter((job) => job.action.type === 'agent' && job.action.libraryProjectId === projectId)
    .map((job) => ({ id: job.id, label: job.name }));
  const automationOptions = agentJobs
    .filter((job) => !(job.action.type === 'agent' && job.action.libraryProjectId === projectId))
    .map((job) => ({ id: job.id, label: job.name }));
  const handleSelectAutomation = (jobId: string) => {
    const job = agentJobs.find((item) => item.id === jobId);
    if (!job || job.action.type !== 'agent') return;
    void cronClient.updateJob(jobId, { action: { ...job.action, libraryProjectId: projectId } })
      .then(loadAgentJobs)
      .catch(() => undefined);
  };
  const handleUnselectAutomation = (jobId: string) => {
    const job = agentJobs.find((item) => item.id === jobId);
    if (!job || job.action.type !== 'agent') return;
    // host updateJob 是整体替换 action（{...definition, ...updates} 中 action 作为整值覆盖），
    // 省略 libraryProjectId 键即清除，无需设 'global' 占位
    const { libraryProjectId: _dropped, ...restAction } = job.action;
    void cronClient.updateJob(jobId, { action: restAction })
      .then(loadAgentJobs)
      .catch(() => undefined);
  };

  if (collapsed) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center border-l border-zinc-800/70 py-3" data-testid="project-space-config-rail-collapsed">
        <IconButton
          size="sm"
          variant="ghost"
          icon={<PanelRightOpen className="h-4 w-4" />}
          aria-label={ps.expandRail}
          title={ps.expandRail}
          data-testid="project-space-config-rail-expand"
          onClick={toggleCollapsed}
        />
      </aside>
    );
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-zinc-800/70" data-testid="project-space-config-rail">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3">
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
          configureLabel={ps.configure}
          onConfigure={() => openCapabilityHub('experts')}
          addLabel={ps.add}
          removeLabel={ps.remove}
          selectedEmptyLabel={ps.selectedEmpty}
          pickerEmptyLabel={ps.pickerEmpty}
          selected={expertSelected}
          options={expertOptions}
          onSelect={handleAddExpert}
          onRemove={handleRemoveExpert}
        />
        <ProjectConfigCard
          testId="project-space-card-skills"
          title={ps.cardSkills}
          configureLabel={ps.configure}
          onConfigure={() => openCapabilityHub('skills')}
          addLabel={ps.add}
          removeLabel={ps.remove}
          selectedEmptyLabel={ps.selectedEmpty}
          pickerEmptyLabel={ps.pickerEmpty}
          selected={skillSelected}
          options={skillOptions}
          onSelect={handleSelectSkill}
          onRemove={skillsEditable ? handleUnselectSkill : undefined}
          readOnlyHint={skillsEditable ? null : ps.skillsReadonlyHint}
        />
        <ProjectConfigCard
          testId="project-space-card-connectors"
          title={ps.cardConnectors}
          configureLabel={ps.configure}
          onConfigure={() => openCapabilityHub('connectors')}
          addLabel={ps.add}
          removeLabel={ps.remove}
          selectedEmptyLabel={ps.selectedEmpty}
          pickerEmptyLabel={ps.pickerEmpty}
          selected={connectorSelected}
          options={connectorOptions}
          onSelect={handleSelectConnector}
          onRemove={handleUnselectConnector}
        />
        <ProjectConfigCard
          testId="project-space-card-automation"
          title={ps.cardAutomation}
          configureLabel={ps.configure}
          onConfigure={() => setShowCronCenter(true)}
          addLabel={ps.add}
          removeLabel={ps.remove}
          selectedEmptyLabel={ps.selectedEmpty}
          pickerEmptyLabel={ps.pickerEmpty}
          selected={automationSelected}
          options={automationOptions}
          onSelect={handleSelectAutomation}
          onRemove={handleUnselectAutomation}
        />
      </div>
    </aside>
  );
};

