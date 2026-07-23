import * as fs from 'fs/promises';
import * as path from 'path';
import { getUserConfigDir } from '../../config/configPaths';
import type { TeamRecipe, TeamRecipeValidationError } from '../../../shared/contract/teamRecipe';
import { validateTeamRecipe } from '../../../shared/contract/teamRecipe';
import { createLogger } from '../infra/logger';
import { getTeamRecipeService, type TeamRecipeWrite } from './teamRecipeService';

const logger = createLogger('TeamRecipeDraftQueue');
const DRAFTS_DIR_NAME = 'team-recipe-drafts';
const DRAFT_META_FILENAME = 'draft.json';

interface TeamRecipeDraftMeta extends TeamRecipe {
  sessionId: string;
  createdAt: number;
  status: 'pending';
}

export function getTeamRecipeDraftsDir(): string {
  return path.join(getUserConfigDir(), DRAFTS_DIR_NAME);
}

function draftId(name: string, timestamp: number): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return `${safe || 'team'}-${timestamp}`;
}

export async function listTeamRecipeDrafts(): Promise<TeamRecipeDraftMeta[]> {
  try {
    const entries = await fs.readdir(getTeamRecipeDraftsDir());
    const drafts = await Promise.all(entries.map(async (entry) => {
      try {
        return JSON.parse(await fs.readFile(path.join(getTeamRecipeDraftsDir(), entry, DRAFT_META_FILENAME), 'utf-8')) as TeamRecipeDraftMeta;
      } catch {
        return null;
      }
    }));
    return drafts.filter((draft): draft is TeamRecipeDraftMeta => draft !== null).sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function enqueueTeamRecipeDraft(input: TeamRecipe & { sessionId: string; timestamp?: number }): Promise<{ draft: TeamRecipeDraftMeta | null; reason?: string }> {
  const knownRoleIds = await getTeamRecipeService().knownRoleIds();
  const errors: TeamRecipeValidationError[] = validateTeamRecipe(input, knownRoleIds);
  if (errors.length) return { draft: null, reason: errors.map((error) => error.reason).join('；') };
  const createdAt = input.timestamp ?? Date.now();
  const id = draftId(input.name, createdAt);
  const existing = await listTeamRecipeDrafts();
  if (existing.some((draft) => draft.name === input.name)) {
    return { draft: null, reason: `已有一个待确认的「${input.name}」配方草稿，请先确认或放弃它` };
  }
  const draft: TeamRecipeDraftMeta = { ...input, id, sessionId: input.sessionId, createdAt, status: 'pending' };
  const dir = path.join(getTeamRecipeDraftsDir(), id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, DRAFT_META_FILENAME), JSON.stringify(draft, null, 2), 'utf-8');
  logger.info('Team recipe draft enqueued', { id, name: draft.name });
  return { draft };
}

export async function confirmTeamRecipeDraft(id: string): Promise<{ success: boolean; recipe?: TeamRecipe; error?: string }> {
  const dir = path.join(getTeamRecipeDraftsDir(), path.basename(id));
  let draft: TeamRecipeDraftMeta;
  try {
    draft = JSON.parse(await fs.readFile(path.join(dir, DRAFT_META_FILENAME), 'utf-8')) as TeamRecipeDraftMeta;
  } catch {
    return { success: false, error: `草稿不存在：${id}` };
  }
  try {
    const { id: _draftId, sessionId: _sessionId, createdAt: _createdAt, status: _status, ...recipe } = draft;
    const stored = await getTeamRecipeService().create(recipe as TeamRecipeWrite);
    await fs.rm(dir, { recursive: true, force: true });
    logger.info('Team recipe draft confirmed', { id, recipeId: stored.id });
    return { success: true, recipe: stored };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function rejectTeamRecipeDraft(id: string): Promise<{ success: boolean; error?: string }> {
  const dir = path.join(getTeamRecipeDraftsDir(), path.basename(id));
  try {
    await fs.access(path.join(dir, DRAFT_META_FILENAME));
    await fs.rm(dir, { recursive: true, force: true });
    return { success: true };
  } catch {
    return { success: false, error: `草稿不存在：${id}` };
  }
}
