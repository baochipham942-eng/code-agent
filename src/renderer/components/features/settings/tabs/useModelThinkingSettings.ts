import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type {
  ModelEntrySettings,
  ModelProvider,
  ModelThinkingCapabilityCatalog,
} from '@shared/contract';
import type { RuntimeProviderModel } from '@shared/modelRuntime';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { createLogger } from '../../../../utils/logger';
import type { ProviderConfigMap } from './ModelSettings.helpers';

const logger = createLogger('ModelThinkingSettings');

export function useModelThinkingSettings(
  provider: ModelProvider,
  setProviderConfigs: Dispatch<SetStateAction<ProviderConfigMap>>,
) {
  const [capabilities, setCapabilities] = useState<ModelThinkingCapabilityCatalog>();

  useEffect(() => {
    let cancelled = false;
    setCapabilities(undefined);
    ipcService.invokeDomain<ModelThinkingCapabilityCatalog>(
      IPC_DOMAINS.PROVIDER,
      'get_thinking_capabilities',
      { provider },
    ).then((catalog) => {
      if (!cancelled) setCapabilities(catalog);
    }).catch((error: unknown) => {
      logger.warn('Failed to load model thinking capabilities', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const patchModelSettings = useCallback((
    model: RuntimeProviderModel,
    patch: Partial<ModelEntrySettings>,
  ) => {
    setProviderConfigs((previous) => {
      const providerConfig = previous[provider] ?? { enabled: true };
      const existing = providerConfig.models?.[model.id] ?? {};
      return {
        ...previous,
        [provider]: {
          ...providerConfig,
          enabled: providerConfig.enabled ?? true,
          models: {
            ...providerConfig.models,
            [model.id]: {
              label: model.label,
              enabled: model.enabled,
              capabilities: model.capabilities,
              maxTokens: model.maxTokens,
              supportsTool: model.supportsTool,
              supportsVision: model.supportsVision,
              supportsStreaming: model.supportsStreaming,
              ...existing,
              ...patch,
            },
          },
        },
      };
    });
  }, [provider, setProviderConfigs]);

  return { thinkingCapabilities: capabilities, patchCurrentModelSettings: patchModelSettings };
}
