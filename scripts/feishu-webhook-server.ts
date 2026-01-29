/**
 * 临时飞书 Webhook 验证服务器
 * 用于通过飞书的 URL 验证
 */

import express from 'express';

const app = express();
app.use(express.json());

// 飞书验证请求
app.post('/webhook', (req, res) => {
  console.log('收到请求:', JSON.stringify(req.body, null, 2));

  // 飞书验证请求会发送 challenge
  if (req.body?.challenge) {
    console.log('✅ 收到验证请求，返回 challenge');
    res.json({ challenge: req.body.challenge });
    return;
  }

  // 普通消息
  res.json({ code: 0 });
});

app.get('/webhook', (req, res) => {
  res.send('OK');
});

const PORT = 3200;
app.listen(PORT, () => {
  console.log(`\n飞书 Webhook 验证服务器已启动`);
  console.log(`本地地址: http://localhost:${PORT}/webhook`);
  console.log(`\n需要使用 ngrok 暴露到公网:`);
  console.log(`  ngrok http ${PORT}`);
  console.log(`\n然后将 ngrok 给的 https 地址填入飞书后台`);
});
