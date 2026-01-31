import { TestCase } from '../../src/types.js';

export const D06: TestCase = {
  id: 'D06',
  name: '内存泄漏修复',
  category: 'debugging',
  complexity: 'L3',

  prompt: `src/components/DataFetcher.tsx 中存在内存泄漏问题。

问题描述：
1. 组件使用 setInterval 定期刷新数据，但卸载时未清理
2. 添加了 visibilitychange 事件监听，但未在卸载时移除
3. 异步操作完成时组件可能已卸载，导致状态更新警告

请修复这些内存泄漏问题：
1. 在 useEffect 返回清理函数
2. 保存 interval ID 并在卸载时 clearInterval
3. 移除事件监听器
4. 处理异步操作的组件卸载情况`,

  fixture: 'bug-memory-leak',

  validations: [
    {
      type: 'file-contains',
      target: 'src/components/DataFetcher.tsx',
      contains: ['clearInterval', 'removeEventListener'],
    },
    {
      type: 'file-contains',
      target: 'src/components/DataFetcher.tsx',
      contains: ['return'],
      notContains: ['// Bug:'],
    },
  ],

  expectedBehavior: {
    directExecution: true,
    toolCallRange: { min: 2, max: 15 },
  },

  tags: ['debugging', 'memory-leak', 'react', 'useEffect', 'cleanup'],
  timeout: 180000,
};

export default D06;
