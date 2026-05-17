import { sendControlPlaneEnvelope } from '../../lib/controlPlaneEnvelope';
import { readCloudConfigPayloadForRequest } from '../../lib/controlPlanePayloads';
import type {
  ControlPlaneRequestLike,
  ControlPlaneResponseLike,
} from '../../lib/controlPlaneEnvelope';

export default function handler(req: ControlPlaneRequestLike, res: ControlPlaneResponseLike): void {
  sendControlPlaneEnvelope(req, res, 'cloud_config', () => readCloudConfigPayloadForRequest(req));
}
