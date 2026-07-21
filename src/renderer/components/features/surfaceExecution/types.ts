import type { SurfaceSessionControlActionV1 } from '@shared/contract/surfaceExecution';
import type {
  RendererSurfaceConversationProjectionV1,
  RendererSurfaceSessionProjectionV1,
} from '../../../utils/surfaceExecutionProjection';
import type { SurfaceExecutionTranslationsV1 } from '../../../i18n/surfaceExecution';

export interface SurfaceExecutionControlIntentV1 {
  version: 1;
  conversationId: string;
  surfaceSessionId: string;
  action: SurfaceSessionControlActionV1;
}

export type SurfaceExecutionControlHandlerV1 = (
  intent: SurfaceExecutionControlIntentV1,
) => void | Promise<void>;

export interface SurfaceExecutionConversationPanelProps {
  conversationId: string;
  projection?: RendererSurfaceConversationProjectionV1 | null;
  sessions?: readonly RendererSurfaceSessionProjectionV1[];
  onControl?: SurfaceExecutionControlHandlerV1;
  translations?: SurfaceExecutionTranslationsV1;
  now?: number;
  className?: string;
}
