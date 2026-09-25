import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InputArea } from '../../src/renderer/components/features/chat/ChatInput/InputArea';
import { SendButton } from '../../src/renderer/components/features/chat/ChatInput/SendButton';
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

function ColdStartComposer(): React.ReactElement {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);

  return (
    <form
      className="mx-auto flex max-w-2xl flex-col gap-2 p-6"
      onSubmit={(event) => event.preventDefault()}
    >
      <instrument.HotProbe>
        <InputArea
          value={value}
          onChange={setValue}
          onSubmit={() => undefined}
          onFileSelect={() => undefined}
          isFocused={focused}
          onFocusChange={setFocused}
          actionButtons={<SendButton hasContent={value.length > 0} />}
        />
      </instrument.HotProbe>
    </form>
  );
}

function ColdStartJourney(): React.ReactElement {
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
      await nextFrame();
      const editor = document.querySelector<HTMLElement>('[data-testid="chat-composer-textarea"]');
      if (!editor) throw new Error('cold-start: composer editor missing');
      if (editor.getAttribute('contenteditable') !== 'true') {
        throw new Error('cold-start: composer is not contenteditable');
      }
      editor.focus();
      editor.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      editor.append('x');
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));
      await nextFrame();
      const acceptsInput = editor.getAttribute('data-plain-text') === 'x'
        && editor.getAttribute('aria-disabled') == null;
      if (!acceptsInput) throw new Error('cold-start: composer did not accept input');
      if (!cancelled) {
        publishJourneyResult('cold-start', instrument, {
          acceptsInput: true,
          editorPresent: true,
          typed: editor.getAttribute('data-plain-text'),
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
    <JourneyProfiler id="cold-start" instrument={instrument}>
      <ColdStartComposer />
    </JourneyProfiler>
  );
}

installLongTaskObserver();
markJourneyStarted();
const root = document.getElementById('root');
if (!root) throw new Error('Missing #root for cold-start journey.');
createRoot(root).render(<ColdStartJourney />);
