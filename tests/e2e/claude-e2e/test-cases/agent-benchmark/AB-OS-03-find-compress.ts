import { TestCase } from '../../src/types.js';

/**
 * T2-B: 操作系统交互 (AgentBench OS)
 * 测试复合 bash 命令组合能力
 */
export const ABOS03: TestCase = {
  id: 'AB-OS-03',
  name: '查找并压缩大文件',
  category: 'debugging',
  complexity: 'L2',

  prompt: `找出当前目录下所有大于 1KB 的 .txt 文件，将它们压缩到一个名为 large_files.tar.gz 的归档中。

要求：
1. 使用 find 命令查找大于 1KB 的 .txt 文件
2. 将找到的文件压缩成 tar.gz 格式
3. 归档文件名为 large_files.tar.gz
4. 输出归档中包含的文件列表`,

  fixture: 'typescript-basic',

  setupCommands: [
    'mkdir -p data',
    // 创建一些大于 1KB 的文件
    'dd if=/dev/zero bs=2048 count=1 2>/dev/null | tr "\\0" "a" > data/large1.txt',
    'dd if=/dev/zero bs=1500 count=1 2>/dev/null | tr "\\0" "b" > data/large2.txt',
    // 创建小于 1KB 的文件
    'echo "small file" > data/small.txt',
    'echo "another small" > data/tiny.txt',
  ],

  validations: [
    {
      type: 'file-exists',
      target: 'large_files.tar.gz',
      message: '应创建 large_files.tar.gz 归档文件',
    },
  ],

  processValidations: [
    {
      type: 'tool-used',
      tool: 'bash',
      message: '必须使用 bash 工具',
    },
    {
      type: 'tool-count-min',
      count: 2,
      message: '至少需要查找和压缩两步',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    requiredTools: ['bash'],
    toolCallRange: { min: 2, max: 8 },
  },

  tags: ['agent-benchmark', 'os', 'bash', 'archive'],
  timeout: 90000,
};

export default ABOS03;
