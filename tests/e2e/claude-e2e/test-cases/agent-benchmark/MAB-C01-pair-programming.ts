import { TestCase } from '../../src/types.js';

/**
 * T3-C: 编程协作 (MultiAgentBench)
 * 测试双 Agent Pair Programming 模式
 */
export const MABC01: TestCase = {
  id: 'MAB-C01',
  name: '结对编程：排序算法',
  category: 'multi-file',
  complexity: 'L2',

  prompt: `使用结对编程模式实现一个通用排序算法库。

任务分工：
- Agent A (coder): 编写排序算法实现
- Agent B (tester): 编写测试用例验证正确性

需要实现的排序算法：
1. 快速排序 (quickSort)
2. 归并排序 (mergeSort)
3. 堆排序 (heapSort)

要求：
1. 每个算法需要能处理数字数组和自定义比较函数
2. 测试用例需覆盖：空数组、单元素、已排序、逆序、随机数组
3. 测试需验证稳定性（对于稳定排序算法）

需要创建的文件：
- src/sorting/quickSort.ts
- src/sorting/mergeSort.ts
- src/sorting/heapSort.ts
- src/sorting/index.ts
- src/sorting/__tests__/sorting.test.ts`,

  fixture: 'typescript-basic',

  validations: [
    {
      type: 'file-exists',
      target: 'src/sorting/quickSort.ts',
    },
    {
      type: 'file-exists',
      target: 'src/sorting/mergeSort.ts',
    },
    {
      type: 'file-exists',
      target: 'src/sorting/heapSort.ts',
    },
    {
      type: 'file-exists',
      target: 'src/sorting/__tests__/sorting.test.ts',
    },
    {
      type: 'file-contains',
      target: 'src/sorting/quickSort.ts',
      contains: ['pivot', 'partition'],
      ignoreCase: true,
    },
    {
      type: 'file-contains',
      target: 'src/sorting/__tests__/sorting.test.ts',
      contains: ['test', 'expect'],
      ignoreCase: true,
    },
  ],

  processValidations: [
    {
      type: 'agent-dispatched',
      message: '应调度子 Agent 进行结对编程',
    },
    {
      type: 'agent-type',
      agentType: ['coder', 'tester'],
      message: '应调度 coder 和 tester Agent',
    },
  ],

  expectedBehavior: {
    expectedAgents: ['coder', 'tester'],
    toolCallRange: { min: 4, max: 15 },
  },

  tags: ['agent-benchmark', 'multi-agent', 'pair-programming', 'algorithm'],
  timeout: 240000,
};

export default MABC01;
