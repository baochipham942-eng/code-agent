import { TestCase } from '../../src/types.js';

/**
 * 混合场景：代码库分析与文档生成
 * 测试 glob + read + analysis + write 综合能力
 */
export const HYB03: TestCase = {
  id: 'HYB-03',
  name: '代码库分析与文档生成',
  category: 'documentation',
  complexity: 'L3',

  prompt: `分析当前项目的代码结构，生成架构文档。

任务：
1. 扫描项目目录结构
2. 识别主要模块和它们的职责
3. 分析模块之间的依赖关系
4. 生成架构文档

文档需包含：
1. 项目概述
2. 目录结构说明
3. 主要模块介绍
4. 模块依赖关系（用 Mermaid 图表示）
5. 关键文件说明

请创建文件 docs/ARCHITECTURE.md`,

  fixture: 'express-api', // 使用一个有实际结构的 fixture

  validations: [
    {
      type: 'file-exists',
      target: 'docs/ARCHITECTURE.md',
    },
    {
      type: 'file-contains',
      target: 'docs/ARCHITECTURE.md',
      contains: ['#', '##'],
      message: '应使用 Markdown 标题格式',
    },
    {
      type: 'file-contains',
      target: 'docs/ARCHITECTURE.md',
      containsAny: ['mermaid', 'graph', '依赖', 'dependency'],
      ignoreCase: true,
      message: '应包含依赖关系说明',
    },
    {
      type: 'file-contains',
      target: 'docs/ARCHITECTURE.md',
      containsAny: ['src', 'module', '模块', 'component'],
      ignoreCase: true,
      message: '应包含模块说明',
    },
  ],

  processValidations: [
    {
      type: 'tool-used',
      tool: ['glob', 'Glob'],
      message: '应使用 glob 扫描目录',
    },
    {
      type: 'tool-used',
      tool: ['Read', 'read_file'],
      message: '应读取关键文件分析',
    },
    {
      type: 'tool-count-min',
      count: 3,
      message: '至少需要：扫描 → 读取 → 写入',
    },
  ],

  expectedBehavior: {
    requiredTools: ['Glob', 'Read'],
    toolCallRange: { min: 3, max: 20 },
  },

  tags: ['agent-benchmark', 'hybrid', 'analysis', 'documentation'],
  timeout: 240000,
};

export default HYB03;
