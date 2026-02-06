import { TestCase } from '../../src/types.js';

/**
 * 混合场景：API SDK 生成器
 * 测试规范解析 + 代码生成 + 测试能力
 */
export const HYB02: TestCase = {
  id: 'HYB-02',
  name: 'API SDK 生成器',
  category: 'generation',
  complexity: 'L3',

  prompt: `根据以下 API 规范，自动生成 TypeScript SDK。

API 规范 (OpenAPI 简化版):
\`\`\`yaml
openapi: 3.0.0
info:
  title: Todo API
  version: 1.0.0
paths:
  /todos:
    get:
      summary: List all todos
      parameters:
        - name: status
          in: query
          schema:
            type: string
            enum: [pending, completed]
      responses:
        200:
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Todo'
    post:
      summary: Create a todo
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateTodo'
      responses:
        201:
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Todo'
  /todos/{id}:
    get:
      summary: Get a todo by ID
    put:
      summary: Update a todo
    delete:
      summary: Delete a todo
components:
  schemas:
    Todo:
      type: object
      properties:
        id: { type: string }
        title: { type: string }
        status: { type: string }
        createdAt: { type: string, format: date-time }
    CreateTodo:
      type: object
      properties:
        title: { type: string }
      required: [title]
\`\`\`

要求：
1. 创建类型安全的 SDK
2. 包含类型定义
3. 支持自定义 baseURL 和 headers
4. 包含错误处理
5. 提供使用示例

需要创建的文件：
- src/sdk/types.ts - API 类型定义
- src/sdk/client.ts - HTTP 客户端封装
- src/sdk/api.ts - API 方法实现
- src/sdk/index.ts - 导出入口
- src/sdk/example.ts - 使用示例`,

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'file-exists',
      target: 'src/sdk/types.ts',
    },
    {
      type: 'file-exists',
      target: 'src/sdk/client.ts',
    },
    {
      type: 'file-exists',
      target: 'src/sdk/api.ts',
    },
    {
      type: 'file-exists',
      target: 'src/sdk/index.ts',
    },
    {
      type: 'file-contains',
      target: 'src/sdk/types.ts',
      contains: ['Todo', 'CreateTodo', 'interface'],
    },
    {
      type: 'file-contains',
      target: 'src/sdk/api.ts',
      contains: ['getTodos', 'createTodo', 'deleteTodo'],
      ignoreCase: true,
    },
    {
      type: 'file-contains',
      target: 'src/sdk/client.ts',
      contains: ['baseURL', 'fetch'],
      ignoreCase: true,
    },
  ],

  processValidations: [
    {
      type: 'tool-count-min',
      count: 4,
      message: '至少需要创建 4 个核心文件',
    },
  ],

  expectedBehavior: {
    toolCallRange: { min: 4, max: 12 },
  },

  tags: ['agent-benchmark', 'hybrid', 'sdk', 'code-generation'],
  timeout: 240000,
  stepByStepExecution: true,
  steps: [
    {
      instruction: '创建类型定义 src/sdk/types.ts',
      validation: { type: 'file-exists', target: 'src/sdk/types.ts' },
    },
    {
      instruction: '创建 HTTP 客户端 src/sdk/client.ts',
      validation: { type: 'file-exists', target: 'src/sdk/client.ts' },
    },
    {
      instruction: '创建 API 方法 src/sdk/api.ts',
      validation: { type: 'file-exists', target: 'src/sdk/api.ts' },
    },
    {
      instruction: '创建导出入口 src/sdk/index.ts',
      validation: { type: 'file-exists', target: 'src/sdk/index.ts' },
    },
  ],
  nudgeOnMissingFile: true,
};

export default HYB02;
