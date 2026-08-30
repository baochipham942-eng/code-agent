import { useEffect, type FC } from 'react';
import {
  useVoiceInput,
  type UseVoiceInputOptions,
  type UseVoiceInputReturn,
} from '../../../../hooks/useVoiceInput';

interface VoiceInputControllerProps extends UseVoiceInputOptions {
  onStateChange: (state: UseVoiceInputReturn) => void;
}

export const VoiceInputController: FC<VoiceInputControllerProps> = ({
  onStateChange,
  ...options
}) => {
  const voice = useVoiceInput(options);
  useEffect(() => {
    onStateChange(voice);
  }, [
    onStateChange,
    voice.canRetry,
    voice.clearError,
    voice.duration,
    voice.error,
    voice.errorCode,
    voice.inputLevel,
    voice.isEnabled,
    voice.isSupported,
    voice.lastResult,
    voice.partialText,
    voice.retry,
    voice.settings,
    voice.silenceWarning,
    voice.start,
    voice.status,
    voice.stop,
    voice.toggle,
  ]);
  return null;
};
