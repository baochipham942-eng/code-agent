import {
  sendControlPlaneEnvelope,
  type ControlPlaneArtifactKind,
  type ControlPlaneRequestLike,
  type ControlPlaneResponseLike,
} from '../../lib/controlPlaneEnvelope';
import { readPayloadForKind } from '../../lib/controlPlanePayloads';

function firstQueryValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function resolveKind(req: ControlPlaneRequestLike): ControlPlaneArtifactKind | null {
  const raw = firstQueryValue(req.query?.artifact) ?? firstQueryValue(req.query?.kind) ?? 'cloud_config';
  if (raw === 'config' || raw === 'cloud_config') {
    return 'cloud_config';
  }
  if (raw === 'prompts' || raw === 'prompt_registry') {
    return 'prompt_registry';
  }
  return null;
}

export default function handler(req: ControlPlaneRequestLike, res: ControlPlaneResponseLike): void {
  const kind = resolveKind(req);
  if (!kind) {
    res.status(400).json({
      error: 'unsupported_artifact',
      message: 'Supported artifacts are cloud_config and prompt_registry.',
    });
    return;
  }

  sendControlPlaneEnvelope(req, res, kind, () => readPayloadForKind(kind));
}
