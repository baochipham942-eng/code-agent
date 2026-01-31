import { TestCase } from '../../src/types.js';

export const G06: TestCase = {
  id: 'G06',
  name: '购物车模块 (Zustand)',
  category: 'generation',
  complexity: 'L3',

  prompt: `创建一个完整的购物车模块，使用 Zustand 进行状态管理。

需要创建以下文件：
1. src/store/cart.store.ts - Zustand store，包含：
   - CartItem 类型 (id, name, price, quantity)
   - items: CartItem[]
   - addItem, removeItem, updateQuantity, clearCart 方法
   - totalPrice, totalItems computed getters

2. src/components/Cart.tsx - 购物车组件
   - 显示所有商品列表
   - 支持修改数量和删除
   - 显示总价

3. src/components/AddToCartButton.tsx - 添加到购物车按钮组件

请确保类型安全，使用 TypeScript 严格模式。`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-exists',
      target: 'src/store/cart.store.ts',
    },
    {
      type: 'file-contains',
      target: 'src/store/cart.store.ts',
      contains: ['CartItem', 'addItem', 'removeItem', 'totalPrice'],
    },
    {
      type: 'file-exists',
      target: 'src/components/Cart.tsx',
    },
    {
      type: 'file-exists',
      target: 'src/components/AddToCartButton.tsx',
    },
  ],

  expectedBehavior: {
    directExecution: true,
    toolCallRange: { min: 5, max: 20 },
  },

  tags: ['generation', 'zustand', 'state-management', 'react', 'shopping-cart'],
  timeout: 180000,
};

export default G06;
