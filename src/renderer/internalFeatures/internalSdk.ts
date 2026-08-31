import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import * as JsxDevRuntime from 'react/jsx-dev-runtime';
import * as Zustand from 'zustand';
import * as m1 from '../components/primitives/Button';
import * as m2 from '../components/primitives/Modal';
import * as m3 from '../components/primitives/EmptyState';
import * as m4 from '../components/primitives/Badge';
import * as m5 from '../components/primitives/Textarea';
import * as m6 from '../components/primitives/Select';
import * as m7 from '../components/primitives/Toggle';
import * as m8 from '../components/primitives/IconButton';
import * as m9 from '../components/composites/ConfirmDialog';
import * as m10 from '../components/features/shared/FullScreenPage';
import * as m11 from '../components/features/shared/PageContent';
import * as m12 from '../stores/appStore';
import * as m13 from '../stores/authStore';
import * as m14 from '../stores/sessionStore';
import * as m15 from '../services/ipcService';
import * as m16 from '../hooks/useToast';
import * as m17 from '../hooks/useI18n';
import * as m18 from '../utils/accessControl';
import * as m19 from '../utils/sessionPresentation';
import * as m20 from '../styles/zLayers';
import { RENDERER_INTERNAL_SDK_VERSION } from './internalSdkVersion';

const ReactModule = (React as typeof React & { default?: typeof React }).default ?? React;

export const INTERNAL_RENDERER_SDK = Object.freeze({
  version: RENDERER_INTERNAL_SDK_VERSION,
  modules: Object.freeze({
    react: ReactModule,
    'react/jsx-runtime': JsxRuntime,
    'react/jsx-dev-runtime': JsxDevRuntime,
    zustand: Zustand,
    '@renderer/components/primitives/Button': m1,
    '@renderer/components/primitives/Modal': m2,
    '@renderer/components/primitives/EmptyState': m3,
    '@renderer/components/primitives/Badge': m4,
    '@renderer/components/primitives/Textarea': m5,
    '@renderer/components/primitives/Select': m6,
    '@renderer/components/primitives/Toggle': m7,
    '@renderer/components/primitives/IconButton': m8,
    '@renderer/components/composites/ConfirmDialog': m9,
    '@renderer/components/features/shared/FullScreenPage': m10,
    '@renderer/components/features/shared/PageContent': m11,
    '@renderer/stores/appStore': m12,
    '@renderer/stores/authStore': m13,
    '@renderer/stores/sessionStore': m14,
    '@renderer/services/ipcService': m15,
    '@renderer/hooks/useToast': m16,
    '@renderer/hooks/useI18n': m17,
    '@renderer/utils/accessControl': m18,
    '@renderer/utils/sessionPresentation': m19,
    '@renderer/styles/zLayers': m20,
  }),
});

export function installInternalSdk(): void {
  if (window.__NEO_INTERNAL_SDK__) return;
  window.__NEO_INTERNAL_SDK__ = INTERNAL_RENDERER_SDK;
}
