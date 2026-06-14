import type { SessionReplayEvidence } from './sessionReplayEvidence';

export type EvidenceToastTone = 'success' | 'warning' | 'error';

export interface OpenSessionReplayEvidenceDeps {
  openSessionReplay: () => Promise<void> | void;
  openPath: (filePath: string) => Promise<void> | void;
  openExternal: (url: string) => boolean;
  copyText: (text: string) => Promise<boolean>;
  notify: (tone: EvidenceToastTone, message: string) => void;
}

function evidenceKindLabel(evidence: SessionReplayEvidence): string {
  return evidence.type === 'trace' ? 'Trace' : 'Replay';
}

export async function openSessionReplayEvidenceTarget(
  evidence: SessionReplayEvidence,
  deps: OpenSessionReplayEvidenceDeps,
): Promise<void> {
  if (evidence.actionKind === 'sessionReplay') {
    await deps.openSessionReplay();
    return;
  }

  const target = evidence.pathOrUrl?.trim();
  if (!target) {
    deps.notify('warning', '这个 Replay/Trace 证据没有可打开的路径');
    return;
  }

  if (evidence.actionKind === 'file') {
    try {
      await deps.openPath(target);
      deps.notify('success', `已打开 ${evidenceKindLabel(evidence)} 证据`);
    } catch (error) {
      const copied = await deps.copyText(target);
      const suffix = copied ? '，已复制路径' : '';
      deps.notify('error', `打开证据失败：${error instanceof Error ? error.message : String(error)}${suffix}`);
    }
    return;
  }

  if (evidence.actionKind === 'url') {
    if (deps.openExternal(target)) {
      deps.notify('success', `已打开 ${evidenceKindLabel(evidence)} 链接`);
      return;
    }
    const copied = await deps.copyText(target);
    deps.notify(
      copied ? 'success' : 'warning',
      copied ? '已复制证据链接' : '无法打开或复制证据链接',
    );
    return;
  }

  const copied = await deps.copyText(target);
  deps.notify(
    copied ? 'success' : 'warning',
    copied ? '已复制证据位置' : '无法复制证据位置',
  );
}
