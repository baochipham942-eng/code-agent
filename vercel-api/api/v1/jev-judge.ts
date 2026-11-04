import { handleJevJudgeRequest } from '../../lib/jevJudge.js';
import type {
  ControlPlaneRequestLike,
  ControlPlaneResponseLike,
} from '../../lib/controlPlaneEnvelope.js';

// Neo 托管 Jev 判官计量代理（N-JEV-NEO-KEY）：POST {state, questions} → {answers}。
// key/配额/模型全在服务端，见 lib/jevJudge.ts。
export default async function handler(req: ControlPlaneRequestLike, res: ControlPlaneResponseLike): Promise<void> {
  await handleJevJudgeRequest(req, res);
}
