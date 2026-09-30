import { listMemoryFiles, type LightMemoryFile } from '../../lightMemory/lightMemoryIpc';
import { guardSensitiveText } from '../../security/sensitiveDataGuard';

const USER_PROFILE_MAX_CHARS = 600;
const USER_PROFILE_MAX_ENTRIES = 8;
const USER_PROFILE_GUARD_MAX_CHARS = USER_PROFILE_MAX_CHARS;

function profileText(file: LightMemoryFile): string {
  const description = file.description.trim();
  return (description || file.content.split(/\r?\n/u, 1)[0]?.trim() || '').replace(/\s+/gu, ' ').trim();
}

function isUserProfileFile(file: LightMemoryFile): boolean {
  return file.type === 'user'
    && (file.status === undefined || file.status === 'active')
    && (file.scope === undefined || file.scope === 'global')
    && file.memoryTainted !== true;
}

/** Build the compact, already-filtered profile block sent to the realtime provider. */
export function buildUserProfileBlock(files: LightMemoryFile[]): string {
  const lines: string[] = [];
  const candidates = files
    .filter(isUserProfileFile)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  for (const file of candidates) {
    if (lines.length >= USER_PROFILE_MAX_ENTRIES) break;
    const value = profileText(file);
    if (!value) continue;
    const guarded = guardSensitiveText(value, {
      surface: 'prompt',
      mode: 'model-context',
      maxLength: USER_PROFILE_GUARD_MAX_CHARS,
    });
    if (guarded !== value) continue;
    const line = `- ${guarded}`;
    const block = ['[Context — User profile]', ...lines, line].join('\n');
    if (block.length > USER_PROFILE_MAX_CHARS) continue;
    lines.push(line);
  }

  return lines.length ? ['[Context — User profile]', ...lines].join('\n') : '';
}

/** Load the profile without ever making voice setup fail. */
export async function loadVoiceUserProfile(): Promise<string> {
  try {
    return buildUserProfileBlock(await listMemoryFiles());
  } catch {
    return '';
  }
}
