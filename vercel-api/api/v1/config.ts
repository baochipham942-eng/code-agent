import { sendControlPlaneEnvelopeAsync } from '../../lib/controlPlaneEnvelope';
import { readCloudConfigPayloadForRequestAsync } from '../../lib/controlPlanePayloads';
import type {
  ControlPlaneRequestLike,
  ControlPlaneResponseLike,
} from '../../lib/controlPlaneEnvelope';

export default async function handler(req: ControlPlaneRequestLike, res: ControlPlaneResponseLike): Promise<void> {
  await sendControlPlaneEnvelopeAsync(req, res, 'cloud_config', () => readCloudConfigPayloadForRequestAsync(req));
}
