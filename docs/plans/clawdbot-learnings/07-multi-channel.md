# 多通道接入

## 问题描述

当前 Code Agent 只有桌面应用一个入口。Clawdbot 支持：

1. **多通道**：WhatsApp、Telegram、Discord、Slack、Signal、iMessage 等
2. **统一抽象**：通道插件化，统一消息格式
3. **路由绑定**：不同通道可绑定不同 Agent

## Clawdbot 实现分析

### 核心文件
- `src/channels/plugins/types.core.ts` - 通道核心类型
- `src/channels/plugins/index.ts` - 插件注册
- `src/channels/registry.ts` - 通道注册表
- `extensions/` - 各通道扩展实现

### 通道能力定义

```typescript
type ChannelCapabilities = {
  chatTypes: Array<'dm' | 'group' | 'channel' | 'thread'>;
  polls?: boolean;          // 投票
  reactions?: boolean;      // 表情反应
  edit?: boolean;           // 消息编辑
  unsend?: boolean;         // 撤回
  reply?: boolean;          // 回复
  effects?: boolean;        // 特效
  groupManagement?: boolean; // 群管理
  threads?: boolean;        // 线程
  media?: boolean;          // 媒体
  nativeCommands?: boolean; // 原生命令
};
```

### 通道元数据

```typescript
type ChannelMeta = {
  id: string;               // 通道 ID
  label: string;            // 显示名称
  selectionLabel: string;   // 选择时显示
  docsPath: string;         // 文档路径
  blurb: string;            // 简介
  systemImage?: string;     // 图标
  // ...
};
```

### 账号状态

```typescript
type ChannelAccountSnapshot = {
  accountId: string;
  name?: string;
  enabled?: boolean;
  configured?: boolean;
  linked?: boolean;         // 是否已链接
  running?: boolean;        // 是否运行中
  connected?: boolean;      // 是否已连接
  lastConnectedAt?: number;
  lastMessageAt?: number;
  lastError?: string;
  // ...
};
```

## Code Agent 现状

- 仅支持桌面 GUI
- 无 API 接口
- 无多通道概念

## 借鉴方案

### 优先级

考虑到国内用户需求，建议优先级：
1. **飞书**（企业用户刚需）
2. **HTTP API**（通用集成）
3. **Telegram**（个人用户）
4. **微信**（技术难度高，暂缓）

### Step 1: 通道抽象层

```typescript
// src/shared/types/channel.ts

export type ChannelId = 'desktop' | 'api' | 'feishu' | 'telegram' | 'discord' | 'slack';

export interface ChannelCapabilities {
  chatTypes: ('dm' | 'group' | 'channel')[];
  media: boolean;
  reactions: boolean;
  reply: boolean;
  edit: boolean;
  threads: boolean;
}

export interface ChannelMeta {
  id: ChannelId;
  name: string;
  description: string;
  icon?: string;
  capabilities: ChannelCapabilities;
}

export interface ChannelAccountConfig {
  id: string;
  channelId: ChannelId;
  name: string;
  enabled: boolean;
  credentials: Record<string, string>;  // 加密存储
}

export interface ChannelAccountStatus {
  accountId: string;
  channelId: ChannelId;
  connected: boolean;
  lastConnectedAt?: number;
  lastMessageAt?: number;
  lastError?: string;
}

// 统一消息格式
export interface ChannelMessage {
  id: string;
  channelId: ChannelId;
  accountId: string;
  chatType: 'dm' | 'group' | 'channel';
  chatId: string;
  senderId: string;
  senderName?: string;
  content: string;
  attachments?: ChannelAttachment[];
  replyTo?: string;
  timestamp: number;
}

export interface ChannelAttachment {
  type: 'image' | 'file' | 'audio' | 'video';
  url?: string;
  data?: Buffer;
  mimeType: string;
  filename?: string;
  size?: number;
}

// 发送消息请求
export interface ChannelSendRequest {
  channelId: ChannelId;
  accountId: string;
  chatId: string;
  content: string;
  attachments?: ChannelAttachment[];
  replyTo?: string;
}
```

### Step 2: 通道接口

```typescript
// src/main/channels/channelInterface.ts

export interface ChannelPlugin {
  meta: ChannelMeta;

  // 生命周期
  initialize(config: ChannelAccountConfig): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  destroy(): Promise<void>;

  // 状态
  getStatus(): ChannelAccountStatus;
  isConnected(): boolean;

  // 消息
  onMessage(handler: (message: ChannelMessage) => void): void;
  sendMessage(request: ChannelSendRequest): Promise<string>;  // 返回消息 ID

  // 可选能力
  editMessage?(messageId: string, content: string): Promise<void>;
  deleteMessage?(messageId: string): Promise<void>;
  addReaction?(messageId: string, emoji: string): Promise<void>;
}
```

### Step 3: 飞书通道实现

```typescript
// src/main/channels/feishu/feishuChannel.ts
import * as lark from '@larksuiteoapi/node-sdk';
import {
  ChannelPlugin,
  ChannelMeta,
  ChannelAccountConfig,
  ChannelAccountStatus,
  ChannelMessage,
  ChannelSendRequest,
} from '../channelInterface';

export class FeishuChannel implements ChannelPlugin {
  meta: ChannelMeta = {
    id: 'feishu',
    name: '飞书',
    description: '飞书机器人集成',
    icon: 'feishu',
    capabilities: {
      chatTypes: ['dm', 'group'],
      media: true,
      reactions: true,
      reply: true,
      edit: true,
      threads: false,
    },
  };

  private client: lark.Client | null = null;
  private config: ChannelAccountConfig | null = null;
  private wsClient: lark.WSClient | null = null;
  private messageHandler: ((msg: ChannelMessage) => void) | null = null;
  private status: ChannelAccountStatus;

  constructor() {
    this.status = {
      accountId: '',
      channelId: 'feishu',
      connected: false,
    };
  }

  async initialize(config: ChannelAccountConfig): Promise<void> {
    this.config = config;
    this.status.accountId = config.id;

    this.client = new lark.Client({
      appId: config.credentials.appId,
      appSecret: config.credentials.appSecret,
      appType: lark.AppType.SelfBuild,
    });
  }

  async connect(): Promise<void> {
    if (!this.client || !this.config) {
      throw new Error('Channel not initialized');
    }

    // 使用 WebSocket 接收消息
    this.wsClient = new lark.WSClient({
      appId: this.config.credentials.appId,
      appSecret: this.config.credentials.appSecret,
    });

    this.wsClient.start({
      eventDispatcher: new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          await this.handleIncomingMessage(data);
        },
      }),
    });

    this.status.connected = true;
    this.status.lastConnectedAt = Date.now();
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      // 飞书 SDK 的断开连接方法
      this.wsClient = null;
    }
    this.status.connected = false;
  }

  async destroy(): Promise<void> {
    await this.disconnect();
    this.client = null;
    this.config = null;
  }

  getStatus(): ChannelAccountStatus {
    return { ...this.status };
  }

  isConnected(): boolean {
    return this.status.connected;
  }

  onMessage(handler: (message: ChannelMessage) => void): void {
    this.messageHandler = handler;
  }

  async sendMessage(request: ChannelSendRequest): Promise<string> {
    if (!this.client) {
      throw new Error('Channel not connected');
    }

    const response = await this.client.im.message.create({
      data: {
        receive_id: request.chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: request.content }),
      },
      params: {
        receive_id_type: 'chat_id',
      },
    });

    this.status.lastMessageAt = Date.now();
    return response.data?.message_id || '';
  }

  async editMessage(messageId: string, content: string): Promise<void> {
    if (!this.client) {
      throw new Error('Channel not connected');
    }

    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text: content }),
      },
    });
  }

  private async handleIncomingMessage(data: any): Promise<void> {
    if (!this.messageHandler) return;

    const message = data.message;
    const sender = data.sender;

    // 解析消息内容
    let content = '';
    if (message.message_type === 'text') {
      const parsed = JSON.parse(message.content);
      content = parsed.text;
    }

    const channelMessage: ChannelMessage = {
      id: message.message_id,
      channelId: 'feishu',
      accountId: this.status.accountId,
      chatType: message.chat_type === 'p2p' ? 'dm' : 'group',
      chatId: message.chat_id,
      senderId: sender.sender_id.user_id,
      senderName: sender.sender_id.user_id, // 可能需要额外查询
      content,
      timestamp: parseInt(message.create_time),
    };

    this.messageHandler(channelMessage);
  }
}
```

### Step 4: HTTP API 通道

```typescript
// src/main/channels/api/apiChannel.ts
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  ChannelPlugin,
  ChannelMeta,
  ChannelAccountConfig,
  ChannelAccountStatus,
  ChannelMessage,
  ChannelSendRequest,
} from '../channelInterface';

export class ApiChannel implements ChannelPlugin {
  meta: ChannelMeta = {
    id: 'api',
    name: 'HTTP API',
    description: 'RESTful API 接入',
    capabilities: {
      chatTypes: ['dm'],
      media: true,
      reactions: false,
      reply: false,
      edit: false,
      threads: false,
    },
  };

  private app: express.Application | null = null;
  private server: any = null;
  private config: ChannelAccountConfig | null = null;
  private messageHandler: ((msg: ChannelMessage) => void) | null = null;
  private pendingResponses = new Map<string, {
    resolve: (response: string) => void;
    timeout: NodeJS.Timeout;
  }>();
  private status: ChannelAccountStatus;

  constructor() {
    this.status = {
      accountId: '',
      channelId: 'api',
      connected: false,
    };
  }

  async initialize(config: ChannelAccountConfig): Promise<void> {
    this.config = config;
    this.status.accountId = config.id;

    this.app = express();
    this.app.use(express.json());

    // 认证中间件
    this.app.use((req, res, next) => {
      const apiKey = req.headers['x-api-key'];
      if (apiKey !== config.credentials.apiKey) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      next();
    });

    // 发送消息端点
    this.app.post('/api/message', async (req, res) => {
      try {
        const { content, userId, sessionId } = req.body;

        const message: ChannelMessage = {
          id: uuidv4(),
          channelId: 'api',
          accountId: this.status.accountId,
          chatType: 'dm',
          chatId: sessionId || 'default',
          senderId: userId || 'api-user',
          content,
          timestamp: Date.now(),
        };

        // 等待 Agent 响应
        const responsePromise = new Promise<string>((resolve) => {
          const timeout = setTimeout(() => {
            resolve('Request timeout');
          }, 120000); // 2 分钟超时

          this.pendingResponses.set(message.id, { resolve, timeout });
        });

        // 触发消息处理
        this.messageHandler?.(message);

        // 等待响应
        const response = await responsePromise;

        res.json({
          messageId: message.id,
          response,
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // 流式消息端点
    this.app.post('/api/message/stream', async (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const { content, userId, sessionId } = req.body;

      const message: ChannelMessage = {
        id: uuidv4(),
        channelId: 'api',
        accountId: this.status.accountId,
        chatType: 'dm',
        chatId: sessionId || 'default',
        senderId: userId || 'api-user',
        content,
        timestamp: Date.now(),
      };

      // TODO: 实现流式响应
      this.messageHandler?.(message);

      res.write(`data: ${JSON.stringify({ type: 'start', messageId: message.id })}\n\n`);

      // 流式响应逻辑...
    });
  }

  async connect(): Promise<void> {
    if (!this.app || !this.config) {
      throw new Error('Channel not initialized');
    }

    const port = parseInt(this.config.credentials.port) || 3100;

    return new Promise((resolve, reject) => {
      this.server = this.app!.listen(port, () => {
        console.log(`[ApiChannel] Listening on port ${port}`);
        this.status.connected = true;
        this.status.lastConnectedAt = Date.now();
        resolve();
      });

      this.server.on('error', reject);
    });
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
      });
      this.server = null;
    }
    this.status.connected = false;
  }

  async destroy(): Promise<void> {
    await this.disconnect();
    this.app = null;
    this.config = null;
  }

  getStatus(): ChannelAccountStatus {
    return { ...this.status };
  }

  isConnected(): boolean {
    return this.status.connected;
  }

  onMessage(handler: (message: ChannelMessage) => void): void {
    this.messageHandler = handler;
  }

  async sendMessage(request: ChannelSendRequest): Promise<string> {
    // API 通道的响应通过 pendingResponses 机制
    const pending = this.pendingResponses.get(request.chatId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(request.content);
      this.pendingResponses.delete(request.chatId);
    }

    this.status.lastMessageAt = Date.now();
    return uuidv4();
  }
}
```

### Step 5: 通道管理器

```typescript
// src/main/channels/channelManager.ts
import { EventEmitter } from 'events';
import {
  ChannelPlugin,
  ChannelId,
  ChannelAccountConfig,
  ChannelMessage,
  ChannelSendRequest,
} from './channelInterface';
import { FeishuChannel } from './feishu/feishuChannel';
import { ApiChannel } from './api/apiChannel';
import { DatabaseService } from '../services/database';

export class ChannelManager extends EventEmitter {
  private plugins = new Map<ChannelId, new () => ChannelPlugin>();
  private instances = new Map<string, ChannelPlugin>();  // accountId -> instance
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    super();
    this.db = db;

    // 注册内置通道
    this.registerPlugin('feishu', FeishuChannel);
    this.registerPlugin('api', ApiChannel);
  }

  registerPlugin(id: ChannelId, pluginClass: new () => ChannelPlugin): void {
    this.plugins.set(id, pluginClass);
  }

  async initialize(): Promise<void> {
    // 从数据库加载账号配置
    const accounts = await this.db.getChannelAccounts();

    for (const account of accounts) {
      if (account.enabled) {
        await this.connectAccount(account);
      }
    }
  }

  async connectAccount(config: ChannelAccountConfig): Promise<void> {
    const PluginClass = this.plugins.get(config.channelId);
    if (!PluginClass) {
      throw new Error(`Unknown channel: ${config.channelId}`);
    }

    const instance = new PluginClass();

    // 设置消息处理器
    instance.onMessage((message) => {
      this.emit('message', message);
    });

    await instance.initialize(config);
    await instance.connect();

    this.instances.set(config.id, instance);
    console.log(`[ChannelManager] Connected account: ${config.name} (${config.channelId})`);
  }

  async disconnectAccount(accountId: string): Promise<void> {
    const instance = this.instances.get(accountId);
    if (instance) {
      await instance.disconnect();
      await instance.destroy();
      this.instances.delete(accountId);
    }
  }

  async sendMessage(request: ChannelSendRequest): Promise<string> {
    const instance = this.instances.get(request.accountId);
    if (!instance) {
      throw new Error(`Account not connected: ${request.accountId}`);
    }

    return instance.sendMessage(request);
  }

  getStatus(accountId: string) {
    const instance = this.instances.get(accountId);
    if (!instance) return null;
    return instance.getStatus();
  }

  getAllStatus() {
    const statuses: Record<string, any> = {};
    for (const [accountId, instance] of this.instances) {
      statuses[accountId] = instance.getStatus();
    }
    return statuses;
  }

  async shutdown(): Promise<void> {
    for (const [accountId] of this.instances) {
      await this.disconnectAccount(accountId);
    }
  }
}
```

### Step 6: 集成到 AgentOrchestrator

```typescript
// 修改 src/main/agent/agentOrchestrator.ts
export class AgentOrchestrator {
  private channelManager: ChannelManager;

  constructor(db: DatabaseService) {
    this.channelManager = new ChannelManager(db);

    // 监听来自各通道的消息
    this.channelManager.on('message', (message: ChannelMessage) => {
      this.handleChannelMessage(message);
    });
  }

  async handleChannelMessage(message: ChannelMessage): Promise<void> {
    // 1. 路由选择 Agent
    const route = this.routingService.resolve({
      source: message.channelId,
      userId: message.senderId,
    });

    // 2. 创建或获取会话
    const sessionKey = `${message.channelId}:${message.accountId}:${message.chatId}`;
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = await this.createSession(sessionKey, route.agent);
      this.sessions.set(sessionKey, session);
    }

    // 3. 处理消息
    const response = await session.processMessage(message.content);

    // 4. 发送响应
    await this.channelManager.sendMessage({
      channelId: message.channelId,
      accountId: message.accountId,
      chatId: message.chatId,
      content: response,
      replyTo: message.id,
    });
  }
}
```

### Step 7: UI 支持

```typescript
// src/renderer/components/features/settings/ChannelsTab.tsx
export function ChannelsTab() {
  const [accounts, setAccounts] = useState<ChannelAccountConfig[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ChannelAccountStatus>>({});

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3>通道管理</h3>
        <Button onClick={handleAddChannel}>添加通道</Button>
      </div>

      <div className="space-y-3">
        {accounts.map(account => (
          <ChannelCard
            key={account.id}
            account={account}
            status={statuses[account.id]}
            onToggle={() => handleToggle(account.id)}
            onEdit={() => handleEdit(account)}
            onDelete={() => handleDelete(account.id)}
          />
        ))}
      </div>

      {accounts.length === 0 && (
        <div className="text-center py-8 text-gray-500">
          <p>尚未配置任何通道</p>
          <p className="text-sm mt-2">添加飞书、API 等通道来扩展访问方式</p>
        </div>
      )}
    </div>
  );
}

function ChannelCard({ account, status, onToggle, onEdit, onDelete }) {
  const isConnected = status?.connected;

  return (
    <div className="p-4 border rounded">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ChannelIcon channelId={account.channelId} />
          <div>
            <div className="font-medium">{account.name}</div>
            <div className="text-sm text-gray-500">
              {account.channelId}
              {isConnected && (
                <span className="ml-2 text-green-500">● 已连接</span>
              )}
              {!isConnected && account.enabled && (
                <span className="ml-2 text-red-500">● 断开</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={account.enabled} onChange={onToggle} />
          <Button size="sm" variant="ghost" onClick={onEdit}>编辑</Button>
          <Button size="sm" variant="danger" onClick={onDelete}>删除</Button>
        </div>
      </div>

      {status?.lastError && (
        <div className="mt-2 text-sm text-red-500">
          错误: {status.lastError}
        </div>
      )}

      {status?.lastMessageAt && (
        <div className="mt-2 text-xs text-gray-400">
          最后消息: {formatTime(status.lastMessageAt)}
        </div>
      )}
    </div>
  );
}
```

## 验收标准

1. **通道抽象**：统一的通道接口，支持插件化
2. **飞书集成**：可接收和发送飞书消息
3. **HTTP API**：提供 RESTful API 接口
4. **状态监控**：显示各通道连接状态
5. **消息路由**：消息正确路由到对应 Agent
6. **UI 管理**：可通过界面管理通道配置

## 风险与注意事项

1. **凭证安全**：通道凭证需要加密存储
2. **连接稳定性**：需要重连机制
3. **消息限流**：防止消息过载
4. **错误处理**：各通道的错误格式不同

## 依赖

- [@larksuiteoapi/node-sdk](https://github.com/larksuite/node-sdk) - 飞书 SDK
- [express](https://expressjs.com/) - HTTP API 服务器

## 参考资料

- [Clawdbot channels/](https://github.com/clawdbot/clawdbot/tree/main/src/channels)
- [飞书开放平台](https://open.feishu.cn/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
