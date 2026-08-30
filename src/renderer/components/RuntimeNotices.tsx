import React from 'react';
import { AgentNoticeToast } from './AgentNoticeToast';
import { BundledCapabilityRuntime } from './features/capabilityHub/BundledCapabilityRuntime';

export const RuntimeNotices: React.FC = () => (
  <>
    <AgentNoticeToast />
    <BundledCapabilityRuntime />
  </>
);
