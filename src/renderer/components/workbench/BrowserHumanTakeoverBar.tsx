import React from 'react';
import { useI18n } from '../../hooks/useI18n';
import { resumeBrowserHumanTakeover } from '../../hooks/requestBrowserHumanTakeover';
import { useSessionStore } from '../../stores/sessionStore';
import {
  selectActiveBrowserSurfaceSessionV1,
  useSurfaceExecutionStore,
} from '../../stores/surfaceExecutionStore';
import { browserStageOverlayMarker } from '../../utils/browserStageInteractionGate';
import { isUserOpenedSurfaceV1 } from '../../utils/surfaceExecutionProjection';
import { Button } from '../primitives';

/**
 * Live-view bar while the agent browser session is waiting_human.
 * Hidden for a page the user opened themselves.
 * Pure chrome: pointer/click pass-through is blocked by the stage input gate
 * via the overlay marker, not by handlers on this element.
 */
export const BrowserHumanTakeoverBar: React.FC = () => {
  const { t } = useI18n();
  const copy = t.workbenchTabs.agentWindow;
  const conversationId = useSessionStore((state) => state.currentSessionId);
  const activeBrowserSurface = useSurfaceExecutionStore((state) => (
    selectActiveBrowserSurfaceSessionV1(state.sessionsByScope, conversationId)
  ));
  if (!activeBrowserSurface
    || isUserOpenedSurfaceV1(activeBrowserSurface)
    || activeBrowserSurface.session.state !== 'waiting_human') {
    return null;
  }
  const surfaceSessionId = activeBrowserSurface.session.sessionId;
  return (
    <div
      data-testid="browser-human-takeover-bar"
      {...browserStageOverlayMarker}
      className="absolute inset-x-3 bottom-3 z-30 flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-zinc-900/95 px-3 py-2"
    >
      <p className="min-w-0 text-xs text-zinc-200">{copy.takeoverPausedHint}</p>
      <Button
        variant="primary"
        size="sm"
        data-testid="browser-human-takeover-continue"
        onClick={() => {
          void resumeBrowserHumanTakeover({ conversationId, surfaceSessionId });
        }}
      >
        {copy.takeoverContinue}
      </Button>
    </div>
  );
};
