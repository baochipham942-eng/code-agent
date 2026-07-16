import { IPC_DOMAINS } from '@shared/ipc';
import type {
  NeoUIApplyEventRequest,
  NeoUIEventResultV1,
  NeoUIResolveInstanceRequest,
  NeoUIResolveInstanceResult,
  NeoUIResolveManifestRequest,
  NeoUIResolveManifestResult,
} from '@shared/contract/generativeUI';
import ipcService from './ipcService';

export const generativeUIClient = {
  resolveInstance(request: NeoUIResolveInstanceRequest): Promise<NeoUIResolveInstanceResult> {
    return ipcService.invokeDomain(IPC_DOMAINS.GENERATIVE_UI, 'resolveInstance', request);
  },
  applyEvent(request: NeoUIApplyEventRequest): Promise<NeoUIEventResultV1> {
    return ipcService.invokeDomain(IPC_DOMAINS.GENERATIVE_UI, 'applyEvent', request);
  },
  resolveManifest(request: NeoUIResolveManifestRequest): Promise<NeoUIResolveManifestResult> {
    return ipcService.invokeDomain(IPC_DOMAINS.GENERATIVE_UI, 'resolveManifest', request);
  },
};
