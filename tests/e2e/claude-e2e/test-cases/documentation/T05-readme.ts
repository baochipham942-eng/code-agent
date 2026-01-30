import { TestCase } from '../../src/types.js';

export const T05: TestCase = {
  id: 'T05',
  name: 'README 生成',
  category: 'documentation',
  complexity: 'L3',

  prompt: `为这个项目生成完整的 README.md 文档。

需要包含：
1. 项目概述
   - 项目名称和简介
   - 主要功能列表
   - 技术栈

2. 快速开始
   - 环境要求
   - 安装步骤
   - 运行命令

3. 项目结构
   - 目录说明
   - 主要模块介绍

4. API 文档
   - 可用端点列表
   - 请求/响应示例

5. 开发指南
   - 开发环境配置
   - 代码规范
   - 提交规范

请先分析项目结构，然后生成文档。`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-exists',
      target: 'README.md',
    },
    {
      type: 'file-contains',
      target: 'README.md',
      contains: ['#', '安装', 'API', 'npm'],
    },
  ],

  expectedBehavior: {
    // 放宽约束：允许直接执行或分派 agent，主要验证结果
    requiredTools: ['Read', 'Write'],
    toolCallRange: { min: 3, max: 25 },
  },

  tags: ['documentation', 'readme', 'project-docs'],
  timeout: 180000,
};

export default T05;
