// ============================================================================
// Local Bridge Client - 与本地 Bridge 服务通信
// ============================================================================
//
// 在 Web 模式下，通过 HTTP/WebSocket 与用户本地运行的 Bridge 服务
// (localhost:9527) 通信，执行文件/Shell 等本地工具。
//
// ============================================================================

// ============================================================================
// Types
// ============================================================================

export interface HealthResponse {
  status: 'ok' | 'error';
  version: string;
  latestVersion?: string;
  uptime?: number;
  tools?: string[];
}

export interface BridgeToolResponse {
  success: boolean;
  output?: string;
  error?: string;
  duration?: number;
  metadata?: Record<string, unknown>;
}

export interface BridgeToolInfo {
  name: string;
  permissionLevel: string;
  description?: string;
}

export interface BridgeConfirmation {
  requestId: string;
  tool: string;
  params: Record<string, unknown>;
  permissionLevel: string;
  message?: string;
}

// WebSocket 消息类型
export interface BridgeWSMessage {
  type: 'shell_output' | 'confirmation_request' | 'tool_progress' | 'error';
  data: Record<string, unknown>;
}

// ============================================================================
// Client
// ============================================================================

export class LocalBridgeClient {
  private baseUrl: string;
  private token: string | null;
  private ws: WebSocket | null = null;
  private wsListeners = new Map<string, Set<(data: Record<string, unknown>) => void>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(port = 9527) {
    this.baseUrl = `http://localhost:${port}`;
    this.token = localStorage.getItem('bridge-token');
  }

  // --------------------------------------------------------------------------
  // HTTP API
  // --------------------------------------------------------------------------

  /**
   * 健康检查
   */
  async checkHealth(): Promise<HealthResponse | null> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        return await res.json() as HealthResponse;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 调用本地工具
   */
  async invokeTool(tool: string, params: Record<string, unknown>): Promise<BridgeToolResponse> {
    try {
      const res = await fetch(`${this.baseUrl}/tools/invoke`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ tool, params }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        return {
          success: false,
          error: `Bridge error (${res.status}): ${errorText}`,
        };
      }

      return await res.json() as BridgeToolResponse;
    } catch (err) {
      return {
        success: false,
        error: `Bridge connection failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * 列出可用工具
   */
  async listTools(): Promise<BridgeToolInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl}/tools/list`, {
        headers: this.getHeaders(),
      });
      if (res.ok) {
        return await res.json() as BridgeToolInfo[];
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * 确认/拒绝需要权限的操作
   */
  async confirmAction(requestId: string, approved: boolean): Promise<void> {
    await fetch(`${this.baseUrl}/tools/confirm`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ requestId, approved }),
    });
  }

  // --------------------------------------------------------------------------
  // WebSocket (streaming shell output & confirmations)
  // --------------------------------------------------------------------------

  /**
   * 建立 WebSocket 连接
   */
  connectWebSocket(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws';
    const url = this.token ? `${wsUrl}?token=${encodeURIComponent(this.token)}` : wsUrl;

    try {
      this.ws = new WebSocket(url);

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as BridgeWSMessage;
          const listeners = this.wsListeners.get(msg.type);
          if (listeners) {
            listeners.forEach((cb) => cb(msg.data));
          }
        } catch {
          // ignore parse errors
        }
      };

      this.ws.onclose = () => {
        this.ws = null;
        // Auto-reconnect after 5s
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          if (this.wsListeners.size > 0) this.connectWebSocket();
        }, 5000);
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      // connection failed, will retry via onclose
    }
  }

  /**
   * 监听 WebSocket 消息
   */
  onWSMessage(type: string, callback: (data: Record<string, unknown>) => void): () => void {
    if (!this.wsListeners.has(type)) {
      this.wsListeners.set(type, new Set());
    }
    this.wsListeners.get(type)!.add(callback);

    // 确保 WS 连接存在
    this.connectWebSocket();

    return () => {
      const set = this.wsListeners.get(type);
      if (set) {
        set.delete(callback);
        if (set.size === 0) this.wsListeners.delete(type);
      }
    };
  }

  /**
   * 断开 WebSocket
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null; // prevent auto-reconnect
      this.ws.close();
      this.ws = null;
    }
    this.wsListeners.clear();
  }

  // --------------------------------------------------------------------------
  // Token management
  // --------------------------------------------------------------------------

  setToken(token: string): void {
    this.token = token;
    localStorage.setItem('bridge-token', token);
  }

  setPort(port: number): void {
    this.baseUrl = `http://localhost:${port}`;
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    return headers;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let client: LocalBridgeClient | null = null;

export function getLocalBridgeClient(): LocalBridgeClient {
  if (!client) client = new LocalBridgeClient();
  return client;
}

export function resetLocalBridgeClient(): void {
  if (client) {
    client.disconnect();
    client = null;
  }
}
