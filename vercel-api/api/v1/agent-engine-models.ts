import {
  sendControlPlaneEnvelope,
  type ControlPlaneRequestLike,
  type ControlPlaneResponseLike,
} from '../../lib/controlPlaneEnvelope.js';
import { readAgentEngineModelCatalogPayload } from '../../lib/controlPlanePayloads.js';

export default function handler(req: ControlPlaneRequestLike, res: ControlPlaneResponseLike): void {
  sendControlPlaneEnvelope(req, res, 'agent_engine_model_catalog', () => readAgentEngineModelCatalogPayload());
}
