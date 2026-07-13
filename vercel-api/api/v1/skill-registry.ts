import { sendControlPlaneEnvelope } from '../../lib/controlPlaneEnvelope.js';
import { readSkillRegistryPayload } from '../../lib/controlPlanePayloads.js';
import type {
  ControlPlaneRequestLike,
  ControlPlaneResponseLike,
} from '../../lib/controlPlaneEnvelope.js';

export default function handler(req: ControlPlaneRequestLike, res: ControlPlaneResponseLike): void {
  sendControlPlaneEnvelope(req, res, 'skill_registry', () => readSkillRegistryPayload());
}
