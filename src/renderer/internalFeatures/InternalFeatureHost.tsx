import React, { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from '../components/primitives/Button';
import { useI18n } from '../hooks/useI18n';
import { useAppStore } from '../stores/appStore';
import { useInternalFeatureStore } from './internalFeatureStore';
import { RENDERER_INTERNAL_SDK_VERSION } from './internalSdkVersion';

type InternalFeaturePage = React.FC;

const loadCache = new Map<string, Promise<InternalFeaturePage>>();

function globalName(id: string): string {
  return `__neoInternalFeature_${id.replace(/[^A-Za-z0-9]/g, '_')}`;
}

function stylesheetLinks(id: string): HTMLLinkElement[] {
  return Array.from(document.querySelectorAll<HTMLLinkElement>('link[data-internal-feature]'))
    .filter((link) => link.dataset.internalFeature === id);
}

function ensureStylesheet(id: string, cssUrl: string): void {
  const matching = stylesheetLinks(id).find((link) => link.href === new URL(cssUrl, window.location.href).href);
  if (matching) return;
  stylesheetLinks(id).forEach((link) => link.remove());
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = cssUrl;
  link.dataset.internalFeature = id;
  document.head.appendChild(link);
}

function removeStylesheet(id: string, cssUrl: string): void {
  const target = new URL(cssUrl, window.location.href).href;
  stylesheetLinks(id).filter((link) => link.href === target).forEach((link) => link.remove());
}

function loadInternalFeature(
  id: string,
  loadedHash: string,
  entryUrl: string,
  cssUrl: string,
): Promise<InternalFeaturePage> {
  ensureStylesheet(id, cssUrl);
  const cacheKey = `${id}:${loadedHash}`;
  const cached = loadCache.get(cacheKey);
  if (cached) return cached;

  const promise = new Promise<InternalFeaturePage>((resolve, reject) => {
    const name = globalName(id);
    delete (window as unknown as Record<string, unknown>)[name];
    const script = document.createElement('script');
    script.src = entryUrl;
    script.async = true;
    script.dataset.internalFeature = id;
    script.onload = () => {
      const remote = (window as unknown as Record<string, unknown>)[name] as { Page?: unknown } | undefined;
      if (typeof remote?.Page !== 'function') {
        reject(new Error(`Plugin ${id} did not register a Page function`));
        return;
      }
      resolve(remote.Page as InternalFeaturePage);
    };
    script.onerror = () => reject(new Error(`Plugin ${id} script failed to load`));
    document.head.appendChild(script);
  }).catch((error) => {
    loadCache.delete(cacheKey);
    document.querySelectorAll<HTMLScriptElement>('script[data-internal-feature]')
      .forEach((script) => {
        if (script.dataset.internalFeature === id && script.src === new URL(entryUrl, window.location.href).href) {
          script.remove();
        }
      });
    throw error;
  });

  loadCache.set(cacheKey, promise);
  return promise;
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
    void loadInternalFeature(featureId, loadedHash, entryUrl, cssUrl)
      .then((loadedPage) => { if (active) setPage(() => loadedPage); })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error : new Error(String(error));
        console.error(`[InternalFeatureHost] ${featureId} failed to load`, reason);
        if (active) setFailure(reason);
      });
    return () => {
      active = false;
      removeStylesheet(featureId, cssUrl);
    };
  }, [attempt, cssUrl, detail, entryUrl, featureId, loadedHash]);

  if (detail && detail.sdkVersion.renderer !== RENDERER_INTERNAL_SDK_VERSION) {
    return (
      <FailureCard
        title={copy.versionMismatch}
        help={copy.reinstallInHub}
        reinstallLabel={copy.reinstallInHub}
        onReinstall={reinstall}
      />
    );
  }

  if (failure || (detail && !loadedHash)) {
    return (
      <FailureCard
        title={copy.loadFailed.replace('{label}', label)}
        help={copy.loadHelp}
        retryLabel={copy.retry}
        onRetry={() => setAttempt((value) => value + 1)}
        reinstallLabel={copy.reinstall}
        onReinstall={reinstall}
      />
    );
  }

  if (!Page) return <LoadingView text={copy.loading.replace('{label}', label)} />;

  return (
    <RemotePageBoundary
      key={`${loadedHash}:${attempt}`}
      onError={(error) => {
        console.error(`[InternalFeatureHost] ${featureId} page crashed`, error);
        setFailure(error);
      }}
    >
      <Page key={loadedHash} />
    </RemotePageBoundary>
  );
};
