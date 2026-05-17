import { sendControlPlaneEnvelope } from '../lib/controlPlaneEnvelope.js';
import { readPromptRegistryPayload } from '../lib/controlPlanePayloads.js';
import type {
  ControlPlaneRequestLike,
  ControlPlaneResponseLike,
} from '../lib/controlPlaneEnvelope.js';

export default function handler(req: ControlPlaneRequestLike, res: ControlPlaneResponseLike): void {
  sendControlPlaneEnvelope(req, res, 'prompt_registry', () => readPromptRegistryPayload());
}
