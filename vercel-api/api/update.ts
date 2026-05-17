import {
  handleUpdateRequest,
} from '../lib/updateMetadata';
import type {
  ControlPlaneRequestLike,
  ControlPlaneResponseLike,
} from '../lib/controlPlaneEnvelope';

export default async function handler(req: ControlPlaneRequestLike, res: ControlPlaneResponseLike): Promise<void> {
  await handleUpdateRequest(req, res);
}
