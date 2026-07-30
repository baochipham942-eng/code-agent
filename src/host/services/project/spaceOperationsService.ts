import type {
  CreateSpaceInput,
  Project,
  ProjectArtifact,
  ProjectMember,
  ProjectWithActivity,
} from '../../../shared/contract/project';
import { listAllAgents } from '../../agent/agentRegistry';
import { getCronService } from '../../cron/cronService';
import { getDatabase } from '../core/databaseService';
import { getBuiltinRoleVisual } from '../roleAssets';
import { getProjectSkillPreferenceStore } from '../skills/projectSkillPreferenceService';
import { getProjectCollaborationService } from './projectCollaborationService';
import { getProjectService } from './projectService';

export interface SpaceCapabilitySummary {
  experts: Array<{
    id: string;
    displayName: string;
    profession?: string;
    description?: string;
  }>;
  skills: string[];
  connectors: string[];
  automations: Array<{ id: string; name: string; enabled: boolean }>;
}

export interface SpaceRecentActivity {
  activeTopicCount: number;
  lastActivityAt: number | null;
  sessions: Array<{ id: string; title: string; updatedAt: number }>;
}

export interface SpaceQueryResult {
  space: Project;
  cloudMembers: ProjectMember[];
  capabilities: SpaceCapabilitySummary;
  recentActivity: SpaceRecentActivity;
  artifacts: ProjectArtifact[];
}

export interface SpaceOperations {
  list(): ProjectWithActivity[];
  query(projectId: string): Promise<SpaceQueryResult | undefined>;
  create(input: CreateSpaceInput): Promise<Project>;
}

export class SpaceOperationsService implements SpaceOperations {
  list(): ProjectWithActivity[] {
    return getProjectService().listProjectsWithActivity(false, true);
  }

  async query(projectId: string): Promise<SpaceQueryResult | undefined> {
    const normalizedProjectId = projectId.trim();
    if (!normalizedProjectId) throw new Error('projectId is required');

    const projectService = getProjectService();
    const detail = projectService.getProjectDetail(normalizedProjectId);
    if (!detail?.project.spacePromotedAt) return undefined;

    const agents = new Map(listAllAgents().map((agent) => [agent.id, agent]));
    const skills = detail.project.workspacePath
      ? Object.entries(
        getProjectSkillPreferenceStore(detail.project.workspacePath).getAllOverrides(),
      )
        .filter(([, enabled]) => enabled)
        .map(([name]) => name)
        .sort()
      : [];
    const connectors = (projectService.listCapabilitySelections(normalizedProjectId) ?? [])
      .filter((selection) => selection.kind === 'connector')
      .map((selection) => selection.capabilityId)
      .sort();
    const automations = getCronService()
      .listJobs()
      .filter((job) => job.action.type === 'agent' && job.action.libraryProjectId === normalizedProjectId)
      .map((job) => ({ id: job.id, name: job.name, enabled: job.enabled }));
    const activity = projectService
      .listProjectsWithActivity(true, true)
      .find((project) => project.id === normalizedProjectId);
    const database = getDatabase();
    const sessions = detail.sessionIds
      .map((sessionId) => database.getSession(sessionId))
      .filter((session): session is NonNullable<typeof session> => Boolean(session))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 10)
      .map((session) => ({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
      }));

    const cloudMembers = detail.project.cloudProjectId
      ? await getProjectCollaborationService().listMembers(normalizedProjectId)
      : [];

    return {
      space: detail.project,
      cloudMembers,
      capabilities: {
        experts: detail.roles.map((role) => {
          const agent = agents.get(role.roleId);
          const visual = getBuiltinRoleVisual(role.roleId);
          return {
            id: role.roleId,
            displayName: visual?.displayName || agent?.name || role.roleId,
            profession: visual?.profession || agent?.profession,
            description: agent?.description || undefined,
          };
        }),
        skills,
        connectors,
        automations,
      },
      recentActivity: {
        activeTopicCount: activity?.activeTopicCount ?? 0,
        lastActivityAt: activity?.lastActivityAt ?? null,
        sessions,
      },
      artifacts: projectService.getProjectArtifacts(normalizedProjectId, 20),
    };
  }

  create(input: CreateSpaceInput): Promise<Project> {
    return getProjectService().createSpace(input, Date.now());
  }
}

let instance: SpaceOperationsService | null = null;

export function getSpaceOperationsService(): SpaceOperationsService {
  if (!instance) instance = new SpaceOperationsService();
  return instance;
}
