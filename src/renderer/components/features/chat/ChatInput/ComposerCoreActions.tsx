import React from 'react';
import type { UseVoiceInputReturn } from '../../../../hooks/useVoiceInput';
import { SendButton } from './SendButton';
import { VoiceInputButton } from './VoiceInputButton';

const LiveVoiceButton = React.lazy(() => import('../../voice/LiveVoiceButton').then((module) => ({
  default: module.LiveVoiceButton,
})));

export type ComposerCoreAction = 'voice-input' | 'live-voice' | 'send' | 'stop';

interface ComposerCoreActionsProps {
  actions: readonly ComposerCoreAction[];
  voice: UseVoiceInputReturn;
  disabled?: boolean;
  sessionId: string | null;
  hasMessages: boolean;
  configured: boolean;
  isProcessing: boolean;
  isInterrupting?: boolean;
  hasContent: boolean;
  onStop?: () => void;
}

/**
 * 核心操作区的唯一渲染消费点。动作列表决定占位者，子组件不得再次判断可见性。
 * 若调度给出 live-voice 却没有会话，说明单真源契约已坏，必须 fail-loud，不能静默空位。
 */
export const ComposerCoreActions: React.FC<ComposerCoreActionsProps> = ({
  actions,
  voice,
  disabled,
  sessionId,
  hasMessages,
  configured,
  isProcessing,
  isInterrupting,
  hasContent,
  onStop,
}) => (
  <div data-testid="composer-core-actions" className="contents">
    {actions.map((action) => {
      if (action === 'voice-input') {
        return <VoiceInputButton key={action} voice={voice} disabled={disabled} />;
      }
      if (action === 'live-voice') {
        if (!sessionId) {
          throw new Error('composer scheduled live-voice without a sessionId');
        }
        return <React.Suspense key={action} fallback={null}>
          <LiveVoiceButton
            sessionId={sessionId}
            hasMessages={hasMessages}
            disabled={disabled}
            configured={configured}
          />
        </React.Suspense>;
      }
      return (
        <SendButton
          key={action}
          disabled={disabled && !isProcessing}
          // action==='stop' 已经含「无草稿」判定，所以这里不会误进排队发送分支。
          isProcessing={isProcessing || action === 'stop'}
          isInterrupting={isInterrupting}
          hasContent={hasContent}
          type="submit"
          onStop={onStop}
        />
      );
    })}
  </div>
);
