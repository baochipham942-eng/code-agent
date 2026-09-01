import React, { useEffect } from 'react';
import { UI_SLOT_CONTRACTS } from '@shared/contract/uiSlots';
import {
  Slot,
  activatePluginUi,
  declareSlot,
  slots,
  unloadPluginUi,
} from './pluginUiSdk';
import { Z_LAYERS } from '../styles/zLayers';

const InternalFeatureHost = React.lazy(() => import('../internalFeatures/InternalFeatureHost').then(({ InternalFeatureHost: component }) => ({ default: component })));

export const NavAccountItemSlotHost: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  useEffect(() => {
    const dispose = declareSlot('nav.account.item', {
      ...UI_SLOT_CONTRACTS['nav.account.item'],
      declaredBy: 'SidebarAccountMenu',
    });
    return () => dispose();
  }, []);

  return <Slot name="nav.account.item" props={{ onClose }} />;
};

export const HubTabSlotHost: React.FC<{ active: boolean }> = ({ active }) => {
  useEffect(() => {
    const dispose = declareSlot('hub.tab', {
      ...UI_SLOT_CONTRACTS['hub.tab'],
      declaredBy: 'CapabilityHubPage',
    });
    return () => dispose();
  }, []);

  return <Slot name="hub.tab" props={{ active }} />;
};

export const SettingsSectionSlotHost: React.FC = () => {
  useEffect(() => {
    const dispose = declareSlot('settings.section', {
      ...UI_SLOT_CONTRACTS['settings.section'],
      declaredBy: 'SettingsModal',
    });
    return () => dispose();
  }, []);

  return <Slot name="settings.section" />;
};

export const WorkspacePageSlotHost: React.FC<{ fallback: React.ReactNode }> = ({ fallback }) => {
  useEffect(() => {
    const dispose = declareSlot('workspace.page', {
      ...UI_SLOT_CONTRACTS['workspace.page'],
      declaredBy: 'App',
    });
    return () => dispose();
  }, []);

  return <Slot name="workspace.page" fallback={fallback} />;
};

export const ShellOverlaySlotHost: React.FC = () => {
  const overlayClassName = 'pointer-events-none fixed inset-0'; // ds-allow:modal ADR-062 的插件全框浮层座位，不是产品对话框。
  useEffect(() => {
    const dispose = declareSlot('shell.overlay', {
      ...UI_SLOT_CONTRACTS['shell.overlay'],
      declaredBy: 'App',
    });
    return () => dispose();
  }, []);

  return (
    <div
      className={overlayClassName}
      data-plugin-slot-host="shell.overlay"
      style={{ zIndex: Z_LAYERS.modal }}
    >
      <Slot name="shell.overlay" />
    </div>
  );
};

export const ConversationTurnTailSlotHost: React.FC = () => {
  useEffect(() => {
    const dispose = declareSlot('conversation.turnTail', {
      ...UI_SLOT_CONTRACTS['conversation.turnTail'],
      declaredBy: 'TurnBasedTraceView',
    });
    return () => dispose();
  }, []);

  return null;
};

export const ConversationTurnTailSlot: React.FC<{
  sessionId: string;
  turnId: string;
}> = ({ sessionId, turnId }) => {
  return <Slot name="conversation.turnTail" props={{ sessionId, turnId }} />;
};

export const InternalFeatureWorkspaceRegistration: React.FC<{
  featureId: string | null;
}> = ({ featureId }) => {
  useEffect(() => {
    if (!featureId) return undefined;
    let disposed = false;
    void activatePluginUi(featureId, () => {
      if (disposed) return;
      const Page = () => (
        <React.Suspense fallback={null}>
          <InternalFeatureHost featureId={featureId} />
        </React.Suspense>
      );
      slots.inject('workspace.page', () => (
        slots.register({ name: 'workspace.page', key: featureId }, Page)
      ));
    }).then(() => {
      if (disposed) void unloadPluginUi(featureId);
    });

    return () => {
      disposed = true;
      void unloadPluginUi(featureId);
    };
  }, [featureId]);

  return null;
};
