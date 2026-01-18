// ============================================================================
// CloudToolRegistry - 云端工具注册表
// 管理所有云端可用的工具
// ============================================================================

export interface CloudToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
      items?: { type: string };
    }>;
    required: string[];
  };
  execute: (input: Record<string, unknown>) => Promise<string>;
}

// ============================================================================
// 工具注册表
// ============================================================================

const toolRegistry: Map<string, CloudToolDefinition> = new Map();

/**
 * 注册工具
 */
export function registerCloudTool(tool: CloudToolDefinition): void {
  toolRegistry.set(tool.name, tool);
}

/**
 * 获取工具
 */
export function getCloudTool(name: string): CloudToolDefinition | undefined {
  return toolRegistry.get(name);
}

/**
 * 获取所有工具
 */
export function getAllCloudTools(): CloudToolDefinition[] {
  return Array.from(toolRegistry.values());
}

/**
 * 获取工具定义（用于 LLM）
 */
export function getCloudToolDefinitions(): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  return Array.from(toolRegistry.values()).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

/**
 * 执行工具
 */
export async function executeCloudTool(
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  const tool = toolRegistry.get(name);
  if (!tool) {
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }

  try {
    return await tool.execute(input);
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : 'Tool execution failed',
    });
  }
}

// ============================================================================
// 预定义工具 Schema
// ============================================================================

export const CLOUD_TOOL_SCHEMAS = {
  cloud_scrape: {
    name: 'cloud_scrape',
    description: '抓取网页内容并解析。支持 CSS 选择器提取特定内容、JSON-LD 结构化数据提取。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: '要抓取的网页 URL',
        },
        selector: {
          type: 'string',
          description: '可选的 CSS 选择器，只提取特定内容',
        },
        extractJsonLd: {
          type: 'boolean',
          description: '是否提取 JSON-LD 结构化数据',
        },
        timeout: {
          type: 'number',
          description: '超时时间（毫秒），默认 30000',
        },
      },
      required: ['url'],
    },
  },

  cloud_search: {
    name: 'cloud_search',
    description: '使用搜索引擎搜索信息。返回标题、URL、摘要等结果。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: '搜索查询词',
        },
        maxResults: {
          type: 'number',
          description: '返回结果数量，默认 10',
        },
        region: {
          type: 'string',
          description: '搜索区域，如 cn-zh, us-en',
        },
      },
      required: ['query'],
    },
  },

  cloud_api: {
    name: 'cloud_api',
    description: '调用外部 API。支持 REST API 请求，包括各种 HTTP 方法。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'API URL',
        },
        method: {
          type: 'string',
          description: 'HTTP 方法',
          enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
        },
        headers: {
          type: 'object',
          description: '请求头',
        },
        body: {
          type: 'object',
          description: '请求体（POST/PUT/PATCH）',
        },
        timeout: {
          type: 'number',
          description: '超时时间（毫秒），默认 30000',
        },
      },
      required: ['url', 'method'],
    },
  },

  cloud_memory_store: {
    name: 'cloud_memory_store',
    description: '存储信息到云端记忆库。支持向量化存储和语义检索。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        key: {
          type: 'string',
          description: '记忆的唯一标识',
        },
        content: {
          type: 'string',
          description: '要存储的内容',
        },
        metadata: {
          type: 'object',
          description: '附加元数据',
        },
        namespace: {
          type: 'string',
          description: '命名空间，用于分类',
        },
      },
      required: ['key', 'content'],
    },
  },

  cloud_memory_search: {
    name: 'cloud_memory_search',
    description: '从云端记忆库搜索相关信息。使用语义相似度匹配。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: '搜索查询',
        },
        limit: {
          type: 'number',
          description: '返回结果数量，默认 5',
        },
        threshold: {
          type: 'number',
          description: '相似度阈值 (0-1)，默认 0.7',
        },
        namespace: {
          type: 'string',
          description: '命名空间过滤',
        },
      },
      required: ['query'],
    },
  },
};
