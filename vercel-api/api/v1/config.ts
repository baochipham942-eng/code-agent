import { sendControlPlaneEnvelopeAsync } from '../../lib/controlPlaneEnvelope.js';
import { readCloudConfigPayloadForRequestAsync } from '../../lib/controlPlanePayloads.js';
import type {
  ControlPlaneRequestLike,
  ControlPlaneResponseLike,
} from '../../lib/controlPlaneEnvelope.js';

export default async function handler(req: ControlPlaneRequestLike, res: ControlPlaneResponseLike): Promise<void> {
  await sendControlPlaneEnvelopeAsync(req, res, 'cloud_config', () => readCloudConfigPayloadForRequestAsync(req));
}
