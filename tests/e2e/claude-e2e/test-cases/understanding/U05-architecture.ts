import { TestCase } from '../../src/types.js';

export const U05: TestCase = {
  id: 'U05',
  name: '项目架构分析',
  category: 'understanding',
  complexity: 'L3',

  prompt: '分析这个项目的整体架构，说明各模块的职责和依赖关系',

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'output-contains',
      contains: ['api', 'component', 'store'],
    },
  ],

  expectedBehavior: {
    directExecution: false,
    expectedAgents: ['Explore'],
    requiredTools: ['Glob', 'Read'],
    toolCallRange: { min: 5, max: 25 },
  },

  tags: ['understanding', 'architecture', 'analysis'],
  timeout: 180000,
};

export default U05;
