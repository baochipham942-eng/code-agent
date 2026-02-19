// ============================================================================
// Team Manager - 团队生命周期管理
// ============================================================================
// 提供团队的创建、恢复、快照和关闭能力：
// 1. createTeam() - 创建团队并持久化配置
// 2. resumeTeam() - 从磁盘恢复团队状态到内存
// 3. saveSnapshot() - 将内存状态序列化到磁盘
// 4. shutdownTeam() - 保存快照并清理团队
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import { onShutdown } from '../../services/infra/gracefulShutdown';
import { getTeammateService } from './teammateService';
import {
  TeamPersistence,
  type TeamConfig,
  type TeamSnapshot,
  type TeamFindingsData,
  type TeamTasksData,
  type TeamCheckpoint,
} from './teamPersistence';
import {
  exportTasks,
  importTasks,
} from '../../tools/planning/taskStore';
import type { SharedContext } from '../parallelAgentCoordinator';

const logger = createLogger('TeamManager');

// ============================================================================
// TeamManager
// ============================================================================

export class TeamManager {
  private persistence: TeamPersistence;
  private activeTeamId: string | null = null;
  private activeSessionId: string | null = null;
  private shutdownRegistered = false;

  constructor(workingDirectory: string) {
    this.persistence = new TeamPersistence(workingDirectory);
  }

  // --------------------------------------------------------------------------
  // Create
  // --------------------------------------------------------------------------

  async createTeam(options: {
    teamId: string;
    name: string;
    sessionId: string;
    members: TeamConfig['members'];
  }): Promise<TeamConfig> {
    const config: TeamConfig = {
      version: 1,
      teamId: options.teamId,
      name: options.name,
      createdAt: Date.now(),
      members: options.members,
    };

    await this.persistence.saveTeam(config);

    this.activeTeamId = options.teamId;
    this.activeSessionId = options.sessionId;

    // Register teammates in TeammateService
    const teammateService = getTeammateService();
    for (const member of options.members) {
      teammateService.register(member.agentId, member.name, member.role);
    }

    this.registerShutdownHandler();

    logger.info(`Team created: ${options.teamId} with ${options.members.length} members`);
    return config;
  }

  // --------------------------------------------------------------------------
  // Resume
  // --------------------------------------------------------------------------

  async resumeTeam(teamId: string, sessionId: string): Promise<TeamSnapshot | null> {
    const snapshot = await this.persistence.loadSnapshot(teamId);
    if (!snapshot) {
      logger.warn(`Team not found for resume: ${teamId}`);
      return null;
    }

    this.activeTeamId = teamId;
    this.activeSessionId = sessionId;

    // Restore tasks into taskStore
    if (snapshot.tasks.tasks.length > 0) {
      importTasks(sessionId, snapshot.tasks.tasks, snapshot.tasks.counter);
      logger.info(`Restored ${snapshot.tasks.tasks.length} tasks for session ${sessionId}`);
    }

    // Restore teammate registrations
    const teammateService = getTeammateService();
    for (const member of snapshot.config.members) {
      teammateService.register(member.agentId, member.name, member.role);
    }

    this.registerShutdownHandler();

    logger.info(`Team resumed: ${teamId}`);
    return snapshot;
  }

  // --------------------------------------------------------------------------
  // Snapshot
  // --------------------------------------------------------------------------

  async saveSnapshot(sharedContext?: SharedContext): Promise<void> {
    if (!this.activeTeamId || !this.activeSessionId) {
      logger.debug('No active team, skip snapshot');
      return;
    }

    const teamId = this.activeTeamId;
    const sessionId = this.activeSessionId;

    // Export current tasks from memory
    const { tasks, counter } = exportTasks(sessionId);
    const tasksData: TeamTasksData = {
      version: 1,
      teamId,
      counter,
      tasks,
    };

    // Export findings from shared context
    const findingsData: TeamFindingsData = {
      version: 1,
      teamId,
      findings: sharedContext ? Object.fromEntries(sharedContext.findings) : {},
      files: sharedContext ? Object.fromEntries(sharedContext.files) : {},
      decisions: sharedContext ? Object.fromEntries(sharedContext.decisions) : {},
      errors: sharedContext?.errors || [],
    };

    // Build checkpoint from teammate service
    const teammateService = getTeammateService();
    const agents = teammateService.listAgents();
    const checkpoint: TeamCheckpoint = {
      version: 1,
      teamId,
      timestamp: Date.now(),
      activeAgents: agents.filter(a => a.status === 'working').map(a => a.id),
      runningTaskIds: tasks.filter(t => t.status === 'in_progress').map(t => t.id),
      completedTaskIds: tasks.filter(t => t.status === 'completed').map(t => t.id),
    };

    await Promise.all([
      this.persistence.saveTasks(tasksData),
      this.persistence.saveFindings(findingsData),
      this.persistence.saveCheckpoint(checkpoint),
    ]);

    logger.info(`Snapshot saved: ${teamId} (${tasks.length} tasks)`);
  }

  // --------------------------------------------------------------------------
  // Shutdown
  // --------------------------------------------------------------------------

  async shutdownTeam(): Promise<void> {
    if (!this.activeTeamId) return;

    // Save final snapshot
    await this.saveSnapshot();

    // Unregister all agents
    const teammateService = getTeammateService();
    const agents = teammateService.listAgents();
    for (const agent of agents) {
      teammateService.unregister(agent.id);
    }

    logger.info(`Team shutdown: ${this.activeTeamId}`);
    this.activeTeamId = null;
    this.activeSessionId = null;
  }

  // --------------------------------------------------------------------------
  // Query
  // --------------------------------------------------------------------------

  getActiveTeamId(): string | null {
    return this.activeTeamId;
  }

  isActive(): boolean {
    return this.activeTeamId !== null;
  }

  async listTeams(): Promise<string[]> {
    return this.persistence.listTeams();
  }

  async deleteTeam(teamId: string): Promise<boolean> {
    if (this.activeTeamId === teamId) {
      await this.shutdownTeam();
    }
    return this.persistence.deleteTeam(teamId);
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private registerShutdownHandler(): void {
    if (this.shutdownRegistered) return;
    this.shutdownRegistered = true;

    onShutdown('TeamManager', async () => {
      try {
        await this.saveSnapshot();
      } catch (err) {
        logger.error('Failed to save team snapshot on shutdown', err);
      }
    }, 2); // Priority 2: save before most other handlers
  }
}

// ============================================================================
// Singleton
// ============================================================================

let managerInstance: TeamManager | null = null;

export function getTeamManager(workingDirectory?: string): TeamManager {
  if (!managerInstance) {
    if (!workingDirectory) {
      workingDirectory = process.cwd();
    }
    managerInstance = new TeamManager(workingDirectory);
  }
  return managerInstance;
}

export function resetTeamManager(): void {
  managerInstance = null;
}
