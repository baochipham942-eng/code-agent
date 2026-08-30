import { useCallback, useEffect, useRef, useState } from 'react';

const RUN_CONFIRM_WINDOW_MS = 5_000;

export function useRunConfirmation(onConfirmed: () => void): {
  confirmArmed: boolean;
  trigger(): void;
  reset(): void;
} {
  const [confirmArmed, setConfirmArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reset = useCallback(() => {
    setConfirmArmed(false);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  const trigger = useCallback(() => {
    if (confirmArmed) {
      reset();
      onConfirmed();
      return;
    }
    setConfirmArmed(true);
    timerRef.current = setTimeout(reset, RUN_CONFIRM_WINDOW_MS);
  }, [confirmArmed, onConfirmed, reset]);
  useEffect(() => reset, [reset]);
  return { confirmArmed, trigger, reset };
}
