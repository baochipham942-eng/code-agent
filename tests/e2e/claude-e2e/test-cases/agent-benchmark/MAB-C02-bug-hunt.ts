import { TestCase } from '../../src/types.js';

/**
 * T3-C: 编程协作 (MultiAgentBench)
 * 测试多 Agent 协作调试能力
 */
export const MABC02: TestCase = {
  id: 'MAB-C02',
  name: '协作调试：修复多个 Bug',
  category: 'debugging',
  complexity: 'L3',

  prompt: `多个 Agent 协作调试一个有多个 bug 的程序。

程序功能：购物车计算器
Bug 描述：
1. 数量计算错误：修改商品数量后总价不正确
2. 折扣逻辑错误：满减折扣应用顺序不对
3. 异步竞态：并发更新购物车导致数据不一致

任务分工：
- Agent A (debugger): 定位 bug 位置
- Agent B (coder): 修复 bug
- Agent C (tester): 验证修复效果

请分析代码并修复所有 bug，确保测试通过。`,

  fixture: 'bug-logic-array', // 需要创建专门的 fixture

  setupCommands: [
    'mkdir -p src/cart',
    // 创建有 bug 的购物车代码
    `cat > src/cart/cart.ts << 'EOF'
interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

interface Discount {
  type: 'percentage' | 'fixed';
  value: number;
  minAmount?: number;
}

class ShoppingCart {
  private items: CartItem[] = [];
  private discounts: Discount[] = [];

  addItem(item: CartItem) {
    const existing = this.items.find(i => i.id === item.id);
    if (existing) {
      // BUG 1: 应该是 += 而不是 =
      existing.quantity = item.quantity;
    } else {
      this.items.push(item);
    }
  }

  updateQuantity(id: string, quantity: number) {
    const item = this.items.find(i => i.id === id);
    if (item) {
      item.quantity = quantity;
    }
  }

  applyDiscount(discount: Discount) {
    this.discounts.push(discount);
  }

  getTotal(): number {
    let total = this.items.reduce((sum, item) =>
      sum + item.price * item.quantity, 0
    );

    // BUG 2: 满减折扣应该先计算，再计算百分比折扣
    for (const discount of this.discounts) {
      if (discount.type === 'percentage') {
        total = total * (1 - discount.value / 100);
      } else if (discount.type === 'fixed') {
        if (!discount.minAmount || total >= discount.minAmount) {
          total = total - discount.value;
        }
      }
    }

    return total;
  }

  // BUG 3: 异步操作没有正确处理竞态条件
  async updateItemAsync(id: string, updates: Partial<CartItem>) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const item = this.items.find(i => i.id === id);
    if (item) {
      Object.assign(item, updates);
    }
  }
}

export { ShoppingCart, CartItem, Discount };
EOF`,
    // 创建测试文件
    `cat > src/cart/cart.test.ts << 'EOF'
import { ShoppingCart } from './cart';

describe('ShoppingCart', () => {
  test('should accumulate quantity when adding same item', () => {
    const cart = new ShoppingCart();
    cart.addItem({ id: '1', name: 'Apple', price: 10, quantity: 2 });
    cart.addItem({ id: '1', name: 'Apple', price: 10, quantity: 3 });
    expect(cart.getTotal()).toBe(50); // 5 * 10 = 50
  });

  test('should apply fixed discount before percentage', () => {
    const cart = new ShoppingCart();
    cart.addItem({ id: '1', name: 'Item', price: 100, quantity: 1 });
    cart.applyDiscount({ type: 'fixed', value: 20, minAmount: 50 });
    cart.applyDiscount({ type: 'percentage', value: 10 });
    // 正确顺序: (100 - 20) * 0.9 = 72
    expect(cart.getTotal()).toBe(72);
  });
});
EOF`,
  ],

  validations: [
    {
      type: 'file-contains',
      target: 'src/cart/cart.ts',
      contains: ['+='],
      message: 'Bug 1 应修复：使用 += 累加数量',
    },
    {
      type: 'test-pass',
      target: 'src/cart/cart.test.ts',
      message: '所有测试应通过',
    },
  ],

  processValidations: [
    {
      type: 'agent-dispatched',
      message: '应调度多个 Agent 协作',
    },
    {
      type: 'tool-used',
      tool: ['Read', 'read_file'],
      message: '应先读取代码分析问题',
    },
    {
      type: 'tool-used',
      tool: ['Edit', 'edit_file'],
      message: '应使用编辑工具修复 bug',
    },
  ],

  expectedBehavior: {
    expectedAgents: ['debugger', 'coder', 'tester'],
    requiredTools: ['Read', 'Edit'],
    toolCallRange: { min: 4, max: 20 },
  },

  tags: ['agent-benchmark', 'multi-agent', 'debugging', 'collaboration'],
  timeout: 300000,
};

export default MABC02;
