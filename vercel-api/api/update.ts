import {
  handleUpdateRequest,
} from '../lib/updateMetadata.js';
import type {
  ControlPlaneRequestLike,
  ControlPlaneResponseLike,
} from '../lib/controlPlaneEnvelope.js';

export default async function handler(req: ControlPlaneRequestLike, res: ControlPlaneResponseLike): Promise<void> {
  await handleUpdateRequest(req, res);
}
