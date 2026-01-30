import { TestCase } from '../../src/types.js';

export const D08: TestCase = {
  id: 'D08',
  name: '性能问题修复',
  category: 'debugging',
  complexity: 'L4',

  prompt: `项目存在严重的性能问题，页面加载和交互都很慢。

需要排查和优化的问题：

1. 组件渲染性能
   - 检查 UserList.tsx 是否存在不必要的重渲染
   - 是否正确使用 React.memo, useMemo, useCallback

2. API 调用优化
   - 检查是否有重复请求
   - 是否实现了请求缓存或去重

3. 状态管理
   - Store 的 selector 是否导致不必要的更新
   - 是否正确使用浅比较

4. 数据获取
   - 是否实现了分页或虚拟滚动
   - 大数据量时的处理策略

请分析问题原因，并实施优化方案。需要修改多个文件来解决这些问题。`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-contains',
      target: 'src/components/UserList.tsx',
      contains: ['memo', 'useCallback'],
    },
  ],

  expectedBehavior: {
    directExecution: false,
    expectedAgents: ['Explore'],
    requiredTools: ['Read', 'Edit', 'Glob'],
    toolCallRange: { min: 8, max: 30 },
  },

  tags: ['debugging', 'performance', 'optimization', 'react'],
  timeout: 300000,
};

export default D08;
