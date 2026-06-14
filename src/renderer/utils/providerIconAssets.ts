import { useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import {
  isProviderIconAssetRef,
  parseProviderIconImageDataUrl,
} from '@shared/modelRuntime';
import ipcService from '../services/ipcService';

interface ResolvedProviderIconAsset {
  icon: string;
  dataUrl: string;
}

interface SavedProviderIconAsset {
  icon: string;
  imageBytes: number;
}

const resolvedIconCache = new Map<string, string>();

export function getProviderIconImageSource(icon?: string): string | undefined {
  const parsed = parseProviderIconImageDataUrl(icon);
  if (parsed) return parsed.normalized;
  if (icon && isProviderIconAssetRef(icon)) return resolvedIconCache.get(icon);
  return undefined;
}

export async function saveProviderIconAssetFromDataUrl(args: {
  provider: string;
  dataUrl: string;
}): Promise<SavedProviderIconAsset> {
  const result = await ipcService.invokeDomain<SavedProviderIconAsset>(
    IPC_DOMAINS.SETTINGS,
    'saveProviderIconAsset',
    args,
  );
  if (result.icon) {
    resolvedIconCache.set(result.icon, args.dataUrl);
  }
  return result;
}

export function useProviderIconImageSource(icon?: string): string | undefined {
  const [source, setSource] = useState(() => getProviderIconImageSource(icon));

  useEffect(() => {
    let cancelled = false;
    const immediate = getProviderIconImageSource(icon);
    setSource(immediate);

    if (!icon || immediate || !isProviderIconAssetRef(icon)) return () => {
      cancelled = true;
    };

    void ipcService.invokeDomain<ResolvedProviderIconAsset>(
      IPC_DOMAINS.SETTINGS,
      'resolveProviderIconAsset',
      { icon },
    ).then((result) => {
      if (cancelled) return;
      if (result.dataUrl) {
        resolvedIconCache.set(icon, result.dataUrl);
        setSource(result.dataUrl);
      }
    }).catch(() => {
      if (!cancelled) setSource(undefined);
    });

    return () => {
      cancelled = true;
    };
  }, [icon]);

  return source;
}
