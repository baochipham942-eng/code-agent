// ============================================================================
// Permission Store - 权限记忆管理
// ============================================================================
// 管理会话级和持久化的权限决定

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// 权限类型
export type PermissionType =
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'file_delete'
  | 'command'
  | 'dangerous_command'
  | 'network'
  | 'mcp';

// 审批级别
export type ApprovalLevel =
  | 'once'      // 允许一次
  | 'deny'      // 拒绝
  | 'session'   // 本次会话允许
  | 'always'    // 始终允许
  | 'never';    // 永不允许

// 权限请求
export interface PermissionRequestForMemory {
  id: string;
  tool: string;
  type: PermissionType;
  details: {
    filePath?: string;
    command?: string;
    url?: string;
    server?: string;
    toolName?: string;
  };
}

interface PermissionMemory {
  // 会话级记忆（不持久化）
  session: Map<string, 'allow' | 'deny'>;
  // 持久化记忆
  persistent: Record<string, 'allow' | 'deny'>;
}

interface PermissionState {
  memory: PermissionMemory;

  // 检查是否有记忆的决定
  checkMemory: (request: PermissionRequestForMemory) => ApprovalLevel | null;

  // 保存决定到记忆
  saveMemory: (request: PermissionRequestForMemory, level: ApprovalLevel) => void;

  // 清除会话记忆
  clearSessionMemory: () => void;

  // 清除所有持久化记忆
  clearPersistentMemory: () => void;

  // 获取持久化记忆数量
  getPersistentCount: () => number;
}

// 生成记忆键
function getMemoryKey(request: PermissionRequestForMemory): string {
  const { type, details } = request;

  switch (type) {
    case 'file_read':
    case 'file_write':
    case 'file_edit':
    case 'file_delete': {
      // 文件操作使用目录级别的记忆
      const dir = details.filePath?.split('/').slice(0, -1).join('/') || '';
      return `${type}:${dir}`;
    }

    case 'command':
    case 'dangerous_command': {
      // 命令使用命令前缀的记忆
      const cmdPrefix = details.command?.split(' ').slice(0, 2).join(' ') || '';
      return `command:${cmdPrefix}`;
    }

    case 'network': {
      // 网络使用域名级别的记忆
      try {
        const url = new URL(details.url || '');
        return `network:${url.hostname}`;
      } catch {
        return `network:${details.url}`;
      }
    }

    case 'mcp':
      return `mcp:${details.server}/${details.toolName}`;

    default:
      return `${type}:${request.tool}`;
  }
}

export const usePermissionStore = create<PermissionState>()(
  persist(
    (set, get) => ({
      memory: {
        session: new Map(),
        persistent: {},
      },

      checkMemory: (request) => {
        const key = getMemoryKey(request);
        const { memory } = get();

        // 先检查会话记忆
        if (memory.session.has(key)) {
          return memory.session.get(key) === 'allow' ? 'session' : 'deny';
        }

        // 再检查持久化记忆
        if (key in memory.persistent) {
          return memory.persistent[key] === 'allow' ? 'always' : 'never';
        }

        return null;
      },

      saveMemory: (request, level) => {
        const key = getMemoryKey(request);

        set((state) => {
          const newMemory = { ...state.memory };

          if (level === 'session') {
            newMemory.session = new Map(state.memory.session);
            newMemory.session.set(key, 'allow');
          } else if (level === 'always') {
            newMemory.persistent = {
              ...state.memory.persistent,
              [key]: 'allow',
            };
          } else if (level === 'never') {
            newMemory.persistent = {
              ...state.memory.persistent,
              [key]: 'deny',
            };
          }

          return { memory: newMemory };
        });
      },

      clearSessionMemory: () => {
        set((state) => ({
          memory: {
            ...state.memory,
            session: new Map(),
          },
        }));
      },

      clearPersistentMemory: () => {
        set((state) => ({
          memory: {
            ...state.memory,
            persistent: {},
          },
        }));
      },

      getPersistentCount: () => {
        return Object.keys(get().memory.persistent).length;
      },
    }),
    {
      name: 'permission-memory',
      // 只持久化 persistent 部分
      partialize: (state) => ({
        memory: {
          session: new Map(), // 会话记忆不持久化
          persistent: state.memory.persistent,
        },
      }),
    }
  )
);
