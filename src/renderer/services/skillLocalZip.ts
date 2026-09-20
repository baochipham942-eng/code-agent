import { SKILL_CHANNELS } from '@shared/ipc/channels';
import { toast } from '../hooks/useToast';
import { invokeSkillIPC, invokeSkillIPCOrThrow } from './invokeSkillIPC';

export function isSkillZipFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.zip');
}

function nativePathOfFile(file: File): string | undefined {
  const value = (file as File & { path?: string }).path;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) return value;
  return undefined;
}

export function pickWebZipFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      resolve(file);
    };
    input.addEventListener('cancel', () => finish(null));
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.click();
  });
}

export async function fileToLocalZipPayload(file: File): Promise<{ zipPath?: string; archiveBase64?: string }> {
  const zipPath = nativePathOfFile(file);
  if (zipPath) return { zipPath };
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { archiveBase64: btoa(binary) };
}

function isNotASkillPackError(error?: string): boolean {
  return Boolean(error?.startsWith('SKILL_ZIP_MISSING_SKILL_MD'));
}

export async function installLocalSkillZip(payload: {
  zipPath?: string;
  archiveBase64?: string;
}): Promise<{ success: boolean; skillName?: string; pluginSpec?: string; error?: string }> {
  const result = await invokeSkillIPCOrThrow(SKILL_CHANNELS.SKILL_INSTALL_LOCAL_ZIP, payload);
  return result ?? { success: false, error: 'SKILL_ZIP_INSTALL_FAILED' };
}

export async function mountInstalledSkill(sessionId: string, skillName: string): Promise<boolean> {
  const mounted = await invokeSkillIPC(SKILL_CHANNELS.SESSION_MOUNT, sessionId, skillName, 'local-zip');
  return mounted === true;
}

export async function divertDroppedSkillZips(
  files: File[],
  args: {
    sessionId?: string | null;
    successPrefix: string;
    failPrefix: string;
    confirmPrompt: string;
  },
): Promise<File[]> {
  const leftover: File[] = [];
  for (const file of files) {
    try {
      const confirmed = window.confirm(args.confirmPrompt.replace('{name}', file.name));
      if (!confirmed) {
        leftover.push(file);
        continue;
      }
      const result = await installLocalSkillZip(await fileToLocalZipPayload(file));
      if (!result.success && isNotASkillPackError(result.error)) {
        leftover.push(file);
        continue;
      }
      if (!result.success) {
        toast.error(`${args.failPrefix}${result.error || file.name}`);
        continue;
      }
      if (args.sessionId && result.skillName) {
        await mountInstalledSkill(args.sessionId, result.skillName);
      }
      toast.success(`${args.successPrefix}${result.skillName || file.name}`);
    } catch (error) {
      toast.error(`${args.failPrefix}${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return leftover;
}
