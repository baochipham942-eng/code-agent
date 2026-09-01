// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledCapabilityPackage } from '../../../src/shared/contract/capabilityPackage';
import { zh } from '../../../src/renderer/i18n/zh';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh }),
}));

import { InternalFeatureHost } from '../../../src/renderer/internalFeatures/InternalFeatureHost';
import { RENDERER_INTERNAL_SDK_VERSION } from '../../../src/renderer/internalFeatures/internalSdkVersion';
import { useInternalFeatureStore } from '../../../src/renderer/internalFeatures/internalFeatureStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

function feature(id: string, loadedHash: string, renderer = RENDERER_INTERNAL_SDK_VERSION): InstalledCapabilityPackage {
  return {
    id,
    name: '评测中心',
    version: '1.0.0',
    description: 'fixture',
    permissions: [],
    state: 'active',
    surface: 'internal-feature',
    toolNames: [],
    internalFeature: {
      id,
      label: '评测中心',
      sdkVersion: { host: 'host0001', renderer },
      rendererEntry: 'dist/renderer/index.js',
      rendererStyles: 'dist/renderer/index.css',
      hostEntry: 'dist/host/index.cjs',
      loadedHash,
    },
  };
}

function pluginGlobal(id: string): string {
  return `__neoInternalFeature_${id.replace(/[^A-Za-z0-9]/g, '_')}`;
}

function currentScript(id: string): HTMLScriptElement {
  const script = Array.from(document.querySelectorAll<HTMLScriptElement>('script[data-internal-feature]'))
    .find((item) => item.dataset.internalFeature === id);
  if (!script) throw new Error(`missing script for ${id}`);
  return script;
}

beforeEach(() => {
  useInternalFeatureStore.setState({ features: [], loadedAt: null });
  useAppStore.setState({ activeInternalFeatureId: null, showCapabilityHub: false });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  document.querySelectorAll('[data-internal-feature]').forEach((node) => node.remove());
  vi.restoreAllMocks();
});

describe('InternalFeatureHost', () => {
  it('界面版本不匹配时给出精确提示并打开能力中心插件类目', () => {
    const installed = feature('mismatch-center', 'hash-r3', 'deadbeef');
    useInternalFeatureStore.setState({ features: [installed] });

    render(<InternalFeatureHost featureId={installed.id} />);

    expect(screen.getByText('这个插件的界面版本与当前应用不匹配。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '去能力中心重新安装' }));
    expect(useAppStore.getState()).toMatchObject({ showCapabilityHub: true, capabilityHubTab: 'plugins' });
  });

  it('脚本加载失败后显示失败卡，重试会重新注入脚本', async () => {
    const installed = feature('script-failure', 'hash-r4');
    useInternalFeatureStore.setState({ features: [installed] });
    const view = render(<InternalFeatureHost featureId={installed.id} />);

    expect(screen.getByText('正在打开评测中心…')).toBeTruthy();
    expect(view.container.firstElementChild?.className).toContain('flex-1');
    const first = currentScript(installed.id);
    fireEvent.error(first);
    expect(await screen.findByText('评测中心没能打开。')).toBeTruthy();
    expect(screen.queryByText(/技术|原因/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(currentScript(installed.id)).not.toBe(first));
  });

  it('插件页面运行时抛错会落到同一张失败卡', async () => {
    const installed = feature('crashing-page', 'hash-boundary');
    useInternalFeatureStore.setState({ features: [installed] });
    render(<InternalFeatureHost featureId={installed.id} />);
    (window as unknown as Record<string, unknown>)[pluginGlobal(installed.id)] = {
      Page: () => { throw new Error('render exploded'); },
    };

    fireEvent.load(currentScript(installed.id));

    expect(await screen.findByText('评测中心没能打开。')).toBeTruthy();
  });

  it('装载哈希变化时重新拉脚本并挂载新页面', async () => {
    const id = 'evaluation-center-r6';
    const firstFeature = feature(id, 'hash-a');
    useInternalFeatureStore.setState({ features: [firstFeature] });
    render(<InternalFeatureHost featureId={id} />);
    (window as unknown as Record<string, unknown>)[pluginGlobal(id)] = {
      Page: () => <div>PAGE A</div>,
    };
    fireEvent.load(currentScript(id));
    expect(await screen.findByText('PAGE A')).toBeTruthy();

    const firstScript = currentScript(id);
    await act(async () => {
      useInternalFeatureStore.setState({ features: [feature(id, 'hash-b')] });
    });
    await waitFor(() => {
      const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[data-internal-feature]'));
      expect(scripts).toHaveLength(1);
      expect(scripts[0]?.src).toContain('v=hash-b');
    });
    const secondScript = currentScript(id);
    expect(secondScript).not.toBe(firstScript);
    (window as unknown as Record<string, unknown>)[pluginGlobal(id)] = {
      Page: () => <div>PAGE B</div>,
    };
    fireEvent.load(secondScript);
    expect(await screen.findByText('PAGE B')).toBeTruthy();
  });
});
