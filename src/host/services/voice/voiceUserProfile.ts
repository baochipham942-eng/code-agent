import { listMemoryFiles, type LightMemoryFile } from '../../lightMemory/lightMemoryIpc';
import { guardSensitiveText } from '../../security/sensitiveDataGuard';
import { VOICE_USER_PROFILE } from '../../../shared/constants/voice';
import type { VoiceUserProfileView } from '../../../shared/contract/voice';
import type { AppSettings } from '../../../shared/contract/settings';
import { getConfigService } from '../core/configService';
import { createLogger } from '../infra/logger';

const logger = createLogger('VoiceUserProfile');
const HEADER = '[Context — User profile]';

// LightMemoryFile has no tags/category field. Type/status/scope are authoritative.
// Legacy writers also labelled operating instructions and persona notes as `user`.
// Match category tokens in names, then narrow role/relationship or operating phrases
// in ALL text (a harmless description must not hide an intimate body). Do not ban
// generic family facts, occupations, or ordinary preferences for particular tools.
const PERSONA_CATEGORY = /(?:^|[\s_.:/-])(?:persona|soul|roleplay|role-play|relationship|intimacy|intimate)(?:$|[\s_.:/-])|人设|人格|角色扮演|亲密关系|角色关系/iu;
const PERSONA_TEXT = /\b(?:role[ -]?play|persona|soulmate|intimate relationship|romantic relationship)\b|人设|人格(?:设定|定义)|家庭角色|角色扮演|亲密关系|恋爱关系|父子关系|父女关系|(?:你|助手|Neo).{0,12}(?:是|扮演|作为)(?:我|用户)的(?:儿子|女儿|伴侣|恋人|男友|女友|老公|老婆)|(?:叫我|称呼我|喊我)(?:爸|妈|老公|老婆|主人)|(?:you|assistant|Neo) (?:are|is|act as) (?:my|the user's) (?:son|daughter|partner|lover|boyfriend|girlfriend)|call me (?:dad|daddy|mom|master)/iu;
const OPERATION_CATEGORY = /(?:^|[\s_.:/-])(?:tools?|operations?|workflow|runbook|feedback|instructions?)(?:$|[\s_.:/-])|工具操作|操作(?:笔记|规范|步骤)|工作流|执行规则/iu;
const OPERATION_TEXT = /(?:工具|命令行|终端|脚本|CLI).{0,12}(?:使用规则|操作步骤|调用顺序)|(?:必须|禁止|优先|先|不要).{0,12}(?:调用|执行|运行|使用)(?:工具|命令|脚本|CLI|git\b|npm\b)|\b(?:always|never|must) (?:run|execute|invoke|use)\b|\b(?:git (?:push|commit)|npm (?:run|install)|lark-cli)\b/iu;

function excludesPersona(file: LightMemoryFile): boolean {
  return PERSONA_CATEGORY.test(`${file.filename} ${file.name}`)
    || PERSONA_TEXT.test(`${file.name}\n${file.description}\n${file.content}`);
}

function excludesOperations(file: LightMemoryFile): boolean {
  return OPERATION_CATEGORY.test(`${file.filename} ${file.name}`)
    || OPERATION_TEXT.test(`${file.name}\n${file.description}\n${file.content}`);
}

function safeText(text: string): boolean {
  return guardSensitiveText(text, {
    surface: 'prompt', mode: 'model-context', maxLength: VOICE_USER_PROFILE.MAX_CHARS,
  }) === text;
}

function eligible(file: LightMemoryFile): boolean {
  return (file.status === undefined || file.status === 'active')
    && file.memoryTainted !== true
    && !excludesPersona(file);
}

/** Build a bounded block; reserve project space before adding user facts. */
export function buildUserProfileBlock(files: LightMemoryFile[]): string {
  const candidates = files.filter(eligible).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const projects = [...new Set(candidates
    .filter((file) => file.type === 'project' && file.scope !== 'session')
    .map((file) => file.name.replace(/\s+/gu, ' ').trim())
    .filter((title) => title && title.length <= VOICE_USER_PROFILE.MAX_PROJECT_TITLE_CHARS && allowedText(title)))]
    .slice(0, VOICE_USER_PROFILE.MAX_PROJECTS);
  const projectLines = projects.length ? [`最近在做：${projects.join('、')}`] : [];
  const lines: string[] = [];
  for (const file of candidates) {
    if (file.type !== 'user' || (file.scope !== undefined && file.scope !== 'global') || excludesOperations(file)) continue;
    if (lines.length >= VOICE_USER_PROFILE.MAX_ENTRIES) break;
    const value = (file.description.trim() || file.content.split(/\r?\n/u, 1)[0] || '')
      .replace(/\s+/gu, ' ').trim();
    if (!value || !safeText(value)) continue;
    const line = `- ${value}`;
    if ([HEADER, ...lines, line, ...projectLines].join('\n').length > VOICE_USER_PROFILE.MAX_CHARS) continue;
    lines.push(line);
  }
  return lines.length || projectLines.length ? [HEADER, ...lines, ...projectLines].join('\n') : '';
}

// CATEGORY patterns only describe filenames/names; free text uses the narrow TEXT
// patterns so anything generation emits can be saved back after a small edit.
function allowedText(text: string): boolean {
  return safeText(text) && !PERSONA_TEXT.test(text) && !OPERATION_TEXT.test(text);
}

function validOverride(text: string): boolean {
  return text.length <= VOICE_USER_PROFILE.MAX_CHARS && allowedText(text);
}

async function resolveProfile(settings: NonNullable<NonNullable<AppSettings['voice']>['userProfile']>): Promise<VoiceUserProfileView> {
  const enabled = settings.enabled !== false;
  const override = typeof settings.override === 'string' ? settings.override : null;
  const text = !enabled ? '' : override !== null
    ? (validOverride(override) ? override : '')
    : buildUserProfileBlock(await listMemoryFiles());
  return { enabled, override, text };
}

export async function getVoiceUserProfile(): Promise<VoiceUserProfileView> {
  return resolveProfile(getConfigService().getSettings().voice?.userProfile ?? {});
}

export async function setVoiceUserProfile(settings: { enabled: boolean; override: string | null }): Promise<VoiceUserProfileView> {
  if (settings.enabled && settings.override !== null && !validOverride(settings.override)) {
    throw new Error('VOICE_USER_PROFILE_INVALID');
  }
  // Resolve first: a failed regeneration must not replace a user's saved override.
  const view = await resolveProfile(settings);
  await getConfigService().updateSettings({ voice: { userProfile: settings } });
  return view;
}

/** Loading/settings failures withhold the profile, never silently re-enable it. */
export async function loadVoiceUserProfile(): Promise<string> {
  try {
    return (await getVoiceUserProfile()).text;
  } catch {
    logger.warn('Voice user profile unavailable; withholding profile');
    return '';
  }
}
