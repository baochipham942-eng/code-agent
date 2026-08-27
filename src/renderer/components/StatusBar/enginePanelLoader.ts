import type { IPCResponse } from '@shared/ipc';
import type {
  AgentEngineModelCatalogResult,
  AgentEngineSourceDescriptor,
} from '@shared/contract/agentEngine';

interface EnginePanelLoaderOptions {
  listSources: () => Promise<IPCResponse<AgentEngineSourceDescriptor[]>>;
  listModels: () => Promise<IPCResponse<AgentEngineModelCatalogResult>>;
  onSourcesLoadingChange: (loading: boolean) => void;
  onCatalogLoadingChange: (loading: boolean) => void;
  onSourcesLoaded: (sources: AgentEngineSourceDescriptor[]) => void;
  onCatalogLoaded: (result: AgentEngineModelCatalogResult) => void;
  onCatalogFailed: () => void;
}

/**
 * Starts source detection and model-catalog discovery independently. Source rows are cheap and
 * must become interactive without waiting for the cold model catalog probe.
 */
export function loadEnginePanelData(options: EnginePanelLoaderOptions): () => void {
  let cancelled = false;
  options.onSourcesLoadingChange(true);
  options.onCatalogLoadingChange(true);

  void options.listSources()
    .then((result) => {
      if (cancelled) return;
      if (result?.success && Array.isArray(result.data)) {
        options.onSourcesLoaded(result.data);
      }
    })
    .catch(() => {
      // Keep the previous source snapshot; the model catalog has its own failure state.
    })
    .finally(() => {
      if (!cancelled) options.onSourcesLoadingChange(false);
    });

  void options.listModels()
    .then((result) => {
      if (cancelled) return;
      if (result?.success && result.data?.catalog) {
        options.onCatalogLoaded(result.data);
        return;
      }
      options.onCatalogFailed();
    })
    .catch(() => {
      if (!cancelled) options.onCatalogFailed();
    })
    .finally(() => {
      if (!cancelled) options.onCatalogLoadingChange(false);
    });

  return () => {
    cancelled = true;
  };
}
