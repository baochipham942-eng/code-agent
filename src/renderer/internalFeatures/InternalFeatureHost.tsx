import React, { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from '../components/primitives/Button';
import { useI18n } from '../hooks/useI18n';
import { useAppStore } from '../stores/appStore';
import { useInternalFeatureStore } from './internalFeatureStore';
import { RENDERER_INTERNAL_SDK_VERSION } from './internalSdkVersion';
import { acquireRemoteRendererBundle } from './remoteRendererBundle';

type InternalFeaturePage = React.FC;

function globalName(id: string): string {
  return `__neoInternalFeature_${id.replace(/[^A-Za-z0-9]/g, '_')}`;
}

function loadInternalFeature(
  id: string,
  loadedHash: string,
  entryUrl: string,
  cssUrl: string,
) {
  return acquireRemoteRendererBundle({
    cacheKey: `internal-feature:${id}:${loadedHash}`,
    cssUrl,
    dataAttribute: 'data-internal-feature',
    entryUrl,
    globalName: globalName(id),
    ownerId: id,
    readModule: (value) => {
      const remote = value as { Page?: unknown } | undefined;
      if (typeof remote?.Page !== 'function') {
        throw new Error(`Plugin ${id} did not register a Page function`);
      }
      return remote.Page as InternalFeaturePage;
    },
  });
}

class RemotePageBoundary extends React.Component<{
  children: React.ReactNode;
  onError: (error: Error) => void;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    this.props.onError(error);
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

const LoadingView: React.FC<{ text: string }> = ({ text }) => (
  <div className="grid h-full min-h-0 place-items-center bg-zinc-900 px-8">
    <div className="w-full max-w-md" role="status">
      <p className="mb-5 text-sm text-zinc-400">{text}</p>
      <div className="space-y-3" aria-hidden="true">
        <div className="h-3 w-3/4 animate-pulse rounded bg-zinc-800" />
        <div className="h-3 w-full animate-pulse rounded bg-zinc-800" />
        <div className="h-3 w-5/6 animate-pulse rounded bg-zinc-800" />
      </div>
    </div>
  </div>
);

const FailureCard: React.FC<{
  title: string;
  help: string;
  retryLabel?: string;
  onRetry?: () => void;
  reinstallLabel: string;
  onReinstall: () => void;
}> = ({ title, help, retryLabel, onRetry, reinstallLabel, onReinstall }) => (
  <div className="grid h-full min-h-0 place-items-center bg-zinc-900 px-6">
    <div className="w-full max-w-md rounded-xl border border-red-500/30 bg-red-500/10 p-5" role="alert">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-badge-danger" />
        <div>
          <p className="text-sm font-medium text-badge-danger">{title}</p>
          <p className="mt-2 text-sm text-zinc-400">{help}</p>
        </div>
      </div>
      <div className="mt-5 flex gap-2">
        {onRetry && retryLabel ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>{retryLabel}</Button>
        ) : null}
        <Button variant="secondary" size="sm" onClick={onReinstall}>{reinstallLabel}</Button>
      </div>
    </div>
  </div>
);

// flex flex-col 是承重的：插件页根节点（FullScreenPage inline）靠 flex-1 + min-h-0 拿高度，
// 宿主这层若是 block 容器，那两个类在子元素上全部失效 —— 插件页高度退化成内容高度，
// 页内所有 overflow-y-auto 面板永远不会滚（2026-09-04 评测中心三 tab 滚不动的共因）。
const HostSurface: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-zinc-900">
    {children}
  </div>
);

export const InternalFeatureHost: React.FC<{ featureId: string }> = ({ featureId }) => {
  const { t } = useI18n();
  const copy = t.internalFeatures;
  const feature = useInternalFeatureStore((state) => state.features.find((item) => item.id === featureId));
  const openCapabilityHub = useAppStore((state) => state.openCapabilityHub);
  const [attempt, setAttempt] = useState(0);
  const [Page, setPage] = useState<InternalFeaturePage | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);

  const detail = feature?.internalFeature;
  const label = detail?.label ?? feature?.name ?? featureId;
  const loadedHash = detail?.loadedHash;
  const encodedId = encodeURIComponent(featureId);
  const encodedHash = encodeURIComponent(loadedHash ?? '');
  const entryUrl = `/internal-features/${encodedId}/index.js?v=${encodedHash}`;
  const cssUrl = `/internal-features/${encodedId}/index.css?v=${encodedHash}`;
  const reinstall = () => openCapabilityHub('plugins');

  useEffect(() => {
    if (detail?.sdkVersion.renderer !== RENDERER_INTERNAL_SDK_VERSION || !loadedHash) return;
    let active = true;
    setPage(null);
    setFailure(null);
    const bundle = loadInternalFeature(featureId, loadedHash, entryUrl, cssUrl);
    void bundle.promise
      .then((loadedPage) => { if (active) setPage(() => loadedPage); })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error : new Error(String(error));
        if (active) {
          console.error(`[InternalFeatureHost] ${featureId} failed to load`, reason);
          setFailure(reason);
        }
      });
    return () => {
      active = false;
      bundle.dispose();
    };
  }, [attempt, cssUrl, detail, entryUrl, featureId, loadedHash]);

  if (detail && detail.sdkVersion.renderer !== RENDERER_INTERNAL_SDK_VERSION) {
    return (
      <HostSurface>
        <FailureCard
          title={copy.versionMismatch}
          help={copy.reinstallInHub}
          reinstallLabel={copy.reinstallInHub}
          onReinstall={reinstall}
        />
      </HostSurface>
    );
  }

  if (failure || (detail && !loadedHash)) {
    return (
      <HostSurface>
        <FailureCard
          title={copy.loadFailed.replace('{label}', label)}
          help={copy.loadHelp}
          retryLabel={copy.retry}
          onRetry={() => setAttempt((value) => value + 1)}
          reinstallLabel={copy.reinstall}
          onReinstall={reinstall}
        />
      </HostSurface>
    );
  }

  if (!Page) {
    return (
      <HostSurface>
        <LoadingView text={copy.loading.replace('{label}', label)} />
      </HostSurface>
    );
  }

  return (
    <HostSurface>
      <RemotePageBoundary
        key={`${loadedHash}:${attempt}`}
        onError={(error) => {
          console.error(`[InternalFeatureHost] ${featureId} page crashed`, error);
          setFailure(error);
        }}
      >
        <Page key={loadedHash} />
      </RemotePageBoundary>
    </HostSurface>
  );
};
