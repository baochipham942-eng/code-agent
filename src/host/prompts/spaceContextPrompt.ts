import type { ProjectDetail, WorkspaceScope } from '../../shared/contract/project';
import { listAllAgents } from '../agent/agentRegistry';
import { getCronService } from '../cron/cronService';
import { getDatabase } from '../services/core/databaseService';
import { getProjectService } from '../services/project/projectService';
import { getBuiltinRoleVisual } from '../services/roleAssets';
import { getProjectSkillPreferenceStore } from '../services/skills/projectSkillPreferenceService';

export interface SpaceContextExpert {
  displayName: string;
  profession?: string;
  description?: string;
}

export interface SpaceContextSnapshot {
  projectId: string;
  name: string;
  description?: string;
  initiatingUserId?: string;
  experts: SpaceContextExpert[];
  skills: string[];
  connectors: string[];
  automations: string[];
}

export interface SpaceContextPromptDependencies {
  getProjectDetail(projectId: string): ProjectDetail | undefined;
  getSessionProjectId(sessionId: string): string | null;
  getLatestUserAuthorId(sessionId: string): string | null;
  listExperts(roleIds: readonly string[]): SpaceContextExpert[];
  listSkills(workspacePath: string | null | undefined): string[];
  listConnectors(projectId: string): string[];
  listAutomations(projectId: string): string[];
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function listBlock(label: string, values: readonly string[]): string {
  return `${label}: ${values.length > 0 ? values.map(escapeXml).join(', ') : '(none)'}`;
}

export function renderSpaceContextPrompt(snapshot: SpaceContextSnapshot): string {
  const experts = snapshot.experts.map((expert) => {
    const identity = [expert.displayName, expert.profession].filter(Boolean).join(' · ');
    return expert.description
      ? `${escapeXml(identity)}: ${escapeXml(expert.description)}`
      : escapeXml(identity);
  });

  return [
    '<collaboration_space_context>',
    `space_id: ${escapeXml(snapshot.projectId)}`,
    `space_name: ${escapeXml(snapshot.name)}`,
    `space_description: ${escapeXml(snapshot.description || '(none)')}`,
    `initiating_user_id: ${escapeXml(snapshot.initiatingUserId || '(unknown)')}`,
    listBlock('selected_experts', experts),
    listBlock('selected_skills', snapshot.skills),
    listBlock('selected_connectors', snapshot.connectors),
    listBlock('selected_automations', snapshot.automations),
    '',
    `You are working in the collaboration space "${escapeXml(snapshot.name)}".`,
    'The experts, skills, connectors, and automations above are the capabilities configured for this space.',
    'Prefer these configured capabilities when they fit the request, and treat produced artifacts as belonging to this space.',
    '</collaboration_space_context>',
  ].join('\n');
}

function defaultDependencies(): SpaceContextPromptDependencies {
  const projectService = getProjectService();
  const database = getDatabase();
  return {
    getProjectDetail: (projectId) => projectService.getProjectDetail(projectId),
    getSessionProjectId: (sessionId) => database.getSession(sessionId)?.projectId ?? null,
    getLatestUserAuthorId: (sessionId) => database.getLatestUserAuthorId(sessionId),
    listExperts: (roleIds) => {
      const wanted = new Set(roleIds);
      return listAllAgents()
        .filter((agent) => wanted.has(agent.id))
        .map((agent) => {
          const visual = getBuiltinRoleVisual(agent.id);
          return {
            displayName: visual?.displayName || agent.name || agent.id,
            profession: visual?.profession || agent.profession,
            description: agent.description || undefined,
          };
        });
    },
    listSkills: (workspacePath) => {
      if (!workspacePath) return [];
      return Object.entries(getProjectSkillPreferenceStore(workspacePath).getAllOverrides())
        .filter(([, enabled]) => enabled)
        .map(([name]) => name)
        .sort();
    },
    listConnectors: (projectId) => (
      projectService.listCapabilitySelections(projectId) ?? []
    )
      .filter((selection) => selection.kind === 'connector')
      .map((selection) => selection.capabilityId)
      .sort(),
    listAutomations: (projectId) => getCronService()
      .listJobs()
      .filter((job) => job.action.type === 'agent' && job.action.libraryProjectId === projectId)
      .map((job) => job.name)
      .sort(),
  };
}

export function buildSpaceContextPrompt(
  sessionId: string,
  workspaceScope: WorkspaceScope | undefined,
  deps: SpaceContextPromptDependencies = defaultDependencies(),
): string | null {
  if (!workspaceScope?.projectId) return null;
  if (deps.getSessionProjectId(sessionId) !== workspaceScope.projectId) return null;

  const detail = deps.getProjectDetail(workspaceScope.projectId);
  if (!detail?.project.spacePromotedAt) return null;

  return renderSpaceContextPrompt({
    projectId: detail.project.id,
    name: detail.project.name,
    description: detail.project.description,
    initiatingUserId: deps.getLatestUserAuthorId(sessionId) ?? undefined,
    experts: deps.listExperts(detail.roles.map((role) => role.roleId)),
    skills: deps.listSkills(detail.project.workspacePath),
    connectors: deps.listConnectors(detail.project.id),
    automations: deps.listAutomations(detail.project.id),
  });
}
