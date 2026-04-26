// ============================================================================
// Desktop bridge API type declarations
// ============================================================================

/// <reference types="vite/client" />

import type { ElectronAPI as CommandBridgeAPI, DomainAPI } from '@shared/ipc';

declare global {
  interface Window {
    codeAgentAPI?: CommandBridgeAPI;
    codeAgentDomainAPI?: DomainAPI;
    __CODE_AGENT_HTTP_BRIDGE__?: boolean;
    /**
     * @deprecated Compatibility alias for older renderer modules.
     * Prefer window.codeAgentAPI for new code.
     */
    electronAPI?: CommandBridgeAPI;
    /**
     * @deprecated Compatibility alias for older renderer modules.
     * Prefer window.codeAgentDomainAPI for new code.
     */
    domainAPI?: DomainAPI;
  }
}

export {};
