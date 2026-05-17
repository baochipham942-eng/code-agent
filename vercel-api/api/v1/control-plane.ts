import {
  sendControlPlaneEnvelope,
  sendControlPlaneEnvelopeAsync,
  type ControlPlaneArtifactKind,
  type ControlPlaneRequestLike,
  type ControlPlaneResponseLike,
} from '../../lib/controlPlaneEnvelope';
import { readCloudConfigPayloadForRequestAsync, readPayloadForKind } from '../../lib/controlPlanePayloads';

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
  if (raw === 'capabilities' || raw === 'capability_registry') {
    return 'capability_registry';
  }
  return null;
}

export default async function handler(req: ControlPlaneRequestLike, res: ControlPlaneResponseLike): Promise<void> {
  const kind = resolveKind(req);
  if (!kind) {
    res.status(400).json({
      error: 'unsupported_artifact',
      message: 'Supported artifacts are cloud_config, capability_registry, and prompt_registry.',
    });
    return;
  }

  if (kind === 'cloud_config') {
    await sendControlPlaneEnvelopeAsync(req, res, kind, () => readCloudConfigPayloadForRequestAsync(req));
    return;
  }

  sendControlPlaneEnvelope(req, res, kind, () => readPayloadForKind(kind, req));
}
