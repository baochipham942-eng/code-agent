import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageContent } from '../../src/renderer/components/features/chat/MessageBubble/MessageContent';
import {
  createJourneyInstrument,
  installLongTaskObserver,
  JourneyProfiler,
  markJourneyStarted,
  nextFrame,
  publishJourneyError,
  publishJourneyResult,
} from './journey-probe-instrument';

const instrument = createJourneyInstrument();
const FIRST_TOKEN = 'Hello';

function FirstTokenSurface(): React.ReactElement {
  const [content, setContent] = useState('');

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
      await nextFrame();
      setContent(FIRST_TOKEN);
      await nextFrame();
      const visible = document.body.innerText.includes(FIRST_TOKEN);
      if (!visible) throw new Error('first-token: streamed text was not rendered');
      if (!cancelled) {
        publishJourneyResult('first-token', instrument, {
          firstToken: FIRST_TOKEN,
          visible: true,
        });
      }
      } catch (error) {
        publishJourneyError(error);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-2xl p-6" data-testid="first-token-surface">
      <instrument.HotProbe>
        <MessageContent content={content} isStreaming />
      </instrument.HotProbe>
    </div>
  );
}

function FirstTokenJourney(): React.ReactElement {
  return (
    <JourneyProfiler id="first-token" instrument={instrument}>
      <FirstTokenSurface />
    </JourneyProfiler>
  );
}

installLongTaskObserver();
markJourneyStarted();
const root = document.getElementById('root');
if (!root) throw new Error('Missing #root for first-token journey.');
createRoot(root).render(<FirstTokenJourney />);
