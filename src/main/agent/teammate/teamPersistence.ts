// ============================================================================
// Team Persistence - 团队/任务状态持久化到磁盘
// ============================================================================
// 支持 session 中断后恢复：
// 1. 团队配置（成员、角色、模型）
// 2. 任务列表（SessionTask + counter）
// 3. 共享上下文（findings）
// 4. 最后活跃状态（checkpoint）
// ============================================================================

import * as path from 'path';
import * as fs from 'fs/promises';
import { createLogger } from '../../services/infra/logger';
import { atomicWriteFile } from '../../tools/utils/atomicWrite';
import { getTeamsDir } from '../../config/configPaths';
import type { SessionTask } from '../../../shared/types/planning';
import type { RegisteredAgent } from './types';

const logger = createLogger('TeamPersistence');

// ============================================================================
// Types
// ============================================================================

export interface TeamConfig {
  version: 1;
  teamId: string;
  name: string;
  createdAt: number;
  members: Array<{
    agentId: string;
    name: string;
    role: string;
    model?: { provider: string; model: string };
  }>;
}

export interface TeamTasksData {
  version: 1;
  teamId: string;
  counter: number;
  tasks: SessionTask[];
}

export interface TeamFindingsData {
  version: 1;
  teamId: string;
  findings: Record<string, unknown>;
  files: Record<string, string>;
  decisions: Record<string, string>;
  errors: string[];
}

export interface TeamCheckpoint {
  version: 1;
  teamId: string;
  timestamp: number;
  activeAgents: string[];
  runningTaskIds: string[];
  completedTaskIds: string[];
}

export interface TeamSnapshot {
  config: TeamConfig;
  tasks: TeamTasksData;
  findings: TeamFindingsData;
  checkpoint: TeamCheckpoint;
}

// ============================================================================
// TeamPersistence
// ============================================================================

export class TeamPersistence {
  private workingDirectory: string;

  constructor(workingDirectory: string) {
    this.workingDirectory = workingDirectory;
  }

  // --------------------------------------------------------------------------
  // Directory Management
  // --------------------------------------------------------------------------

  private getTeamDir(teamId: string): string {
    return path.join(getTeamsDir(this.workingDirectory), teamId);
  }

  private async ensureTeamDir(teamId: string): Promise<string> {
    const dir = this.getTeamDir(teamId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  // --------------------------------------------------------------------------
  // Save Operations
  // --------------------------------------------------------------------------

  async saveTeam(config: TeamConfig): Promise<void> {
    const dir = await this.ensureTeamDir(config.teamId);
    const filePath = path.join(dir, 'config.json');
    await atomicWriteFile(filePath, JSON.stringify(config, null, 2));
    logger.info(`Team config saved: ${config.teamId}`);
  }

  async saveTasks(data: TeamTasksData): Promise<void> {
    const dir = await this.ensureTeamDir(data.teamId);
    const filePath = path.join(dir, 'tasks.json');
    await atomicWriteFile(filePath, JSON.stringify(data, null, 2));
    logger.debug(`Tasks saved: ${data.teamId} (${data.tasks.length} tasks)`);
  }

  async saveFindings(data: TeamFindingsData): Promise<void> {
    const dir = await this.ensureTeamDir(data.teamId);
    const filePath = path.join(dir, 'findings.json');
    await atomicWriteFile(filePath, JSON.stringify(data, null, 2));
    logger.debug(`Findings saved: ${data.teamId}`);
  }

  async saveCheckpoint(checkpoint: TeamCheckpoint): Promise<void> {
    const dir = await this.ensureTeamDir(checkpoint.teamId);
    const filePath = path.join(dir, 'checkpoint.json');
    await atomicWriteFile(filePath, JSON.stringify(checkpoint, null, 2));
    logger.debug(`Checkpoint saved: ${checkpoint.teamId}`);
  }

  async saveSnapshot(snapshot: TeamSnapshot): Promise<void> {
    await Promise.all([
      this.saveTeam(snapshot.config),
      this.saveTasks(snapshot.tasks),
      this.saveFindings(snapshot.findings),
      this.saveCheckpoint(snapshot.checkpoint),
    ]);
    logger.info(`Full snapshot saved: ${snapshot.config.teamId}`);
  }

  // --------------------------------------------------------------------------
  // Load Operations
  // --------------------------------------------------------------------------

  async loadTeam(teamId: string): Promise<TeamConfig | null> {
    return this.loadJson<TeamConfig>(teamId, 'config.json');
  }

  async loadTasks(teamId: string): Promise<TeamTasksData | null> {
    return this.loadJson<TeamTasksData>(teamId, 'tasks.json');
  }

  async loadFindings(teamId: string): Promise<TeamFindingsData | null> {
    return this.loadJson<TeamFindingsData>(teamId, 'findings.json');
  }

  async loadCheckpoint(teamId: string): Promise<TeamCheckpoint | null> {
    return this.loadJson<TeamCheckpoint>(teamId, 'checkpoint.json');
  }

  async loadSnapshot(teamId: string): Promise<TeamSnapshot | null> {
    const [config, tasks, findings, checkpoint] = await Promise.all([
      this.loadTeam(teamId),
      this.loadTasks(teamId),
      this.loadFindings(teamId),
      this.loadCheckpoint(teamId),
    ]);

    if (!config) return null;

    return {
      config,
      tasks: tasks || { version: 1, teamId, counter: 0, tasks: [] },
      findings: findings || { version: 1, teamId, findings: {}, files: {}, decisions: {}, errors: [] },
      checkpoint: checkpoint || { version: 1, teamId, timestamp: 0, activeAgents: [], runningTaskIds: [], completedTaskIds: [] },
    };
  }

  // --------------------------------------------------------------------------
  // List / Delete
  // --------------------------------------------------------------------------

  async listTeams(): Promise<string[]> {
    const teamsDir = getTeamsDir(this.workingDirectory);
    try {
      const entries = await fs.readdir(teamsDir, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      return [];
    }
  }

  async deleteTeam(teamId: string): Promise<boolean> {
    const dir = this.getTeamDir(teamId);
    try {
      await fs.rm(dir, { recursive: true, force: true });
      logger.info(`Team deleted: ${teamId}`);
      return true;
    } catch (err) {
      logger.warn(`Failed to delete team: ${teamId}`, err);
      return false;
    }
  }

  async teamExists(teamId: string): Promise<boolean> {
    const configPath = path.join(this.getTeamDir(teamId), 'config.json');
    try {
      await fs.access(configPath);
      return true;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  private async loadJson<T>(teamId: string, filename: string): Promise<T | null> {
    const filePath = path.join(this.getTeamDir(teamId), filename);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }
}
