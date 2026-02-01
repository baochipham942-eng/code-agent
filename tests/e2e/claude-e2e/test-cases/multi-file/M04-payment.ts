import { TestCase } from '../../src/types.js';

export const M04: TestCase = {
  id: 'M04',
  name: '支付集成',
  category: 'multi-file',
  complexity: 'L4',

  prompt: `实现一个完整的支付集成模块（模拟 Stripe）。

需要创建的文件：

1. 配置
   - src/config/payment.config.ts - 支付配置

2. 数据层
   - prisma/schema.prisma 添加：
     - Order (id, userId, amount, status, paymentIntentId, createdAt)
     - Payment (id, orderId, amount, status, provider, metadata)

3. 支付网关
   - src/api/payment/stripe.adapter.ts
     - createPaymentIntent
     - confirmPayment
     - refund
     - handleWebhook

4. 服务层
   - src/api/services/order.service.ts
   - src/api/services/payment.service.ts

5. API 层
   - src/api/routes/orders.ts
   - src/api/routes/payments.ts (包含 webhook endpoint)

6. 前端
   - src/components/Checkout.tsx
   - src/components/PaymentForm.tsx
   - src/components/OrderHistory.tsx

安全要求：
- Webhook 签名验证
- 幂等性处理
- 敏感数据不存明文`,

  fixture: 'fullstack-app',

  validations: [
    {
      type: 'file-contains',
      target: 'prisma/schema.prisma',
      contains: ['Order', 'Payment', 'status'],
    },
    {
      type: 'file-exists',
      target: 'src/api/payment/stripe.adapter.ts',
    },
    {
      type: 'file-contains',
      target: 'src/api/payment/stripe.adapter.ts',
      contains: ['createPaymentIntent', 'webhook'],
    },
    {
      type: 'file-exists',
      target: 'src/api/services/payment.service.ts',
    },
    {
      type: 'file-exists',
      target: 'src/api/routes/payments.ts',
    },
    {
      type: 'file-exists',
      target: 'src/components/Checkout.tsx',
    },
  ],

  expectedBehavior: {
    directExecution: false,
    expectedAgents: ['Explore'],
    requiredTools: ['Read', 'Write', 'Edit', 'Glob'],
    toolCallRange: { min: 12, max: 45 },
  },

  tags: ['multi-file', 'payment', 'stripe', 'integration', 'security'],
  timeout: 600000, // 10分钟（L4 复杂任务）
};

export default M04;
