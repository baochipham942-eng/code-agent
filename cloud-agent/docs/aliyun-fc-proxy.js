/**
 * 阿里云函数计算 - DuckDuckGo 搜索代理
 *
 * 部署步骤：
 * 1. 登录阿里云函数计算控制台 https://fc.console.aliyun.com
 * 2. 创建服务（如 code-agent-proxy）
 * 3. 创建函数：
 *    - 运行环境：Node.js 18
 *    - 请求处理程序：index.handler
 *    - 内存：128MB
 *    - 超时：30s
 * 4. 粘贴此代码
 * 5. 配置 HTTP 触发器（公网访问）
 * 6. 复制触发器 URL 到 Vercel 环境变量 DUCKDUCKGO_PROXY_URL
 */

const https = require('https');
const http = require('http');

exports.handler = async (event, context) => {
  // 解析请求
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  const { query, maxResults = 10 } = body;

  if (!query) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Query is required' })
    };
  }

  try {
    const results = await searchDuckDuckGo(query, maxResults);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: true,
        query,
        results,
        source: 'duckduckgo-proxy'
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: error.message
      })
    };
  }
};

async function searchDuckDuckGo(query, maxResults) {
  const params = new URLSearchParams({ q: query, kl: '' });
  const url = `https://html.duckduckgo.com/html/?${params.toString()}`;

  const html = await httpGet(url, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  });

  const results = [];
  const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;

  let match;
  while ((match = resultPattern.exec(html)) !== null && results.length < maxResults) {
    let matchedUrl = match[1];
    const title = match[2].trim();

    // 解码 DuckDuckGo 重定向 URL
    if (matchedUrl.startsWith('//duckduckgo.com/l/?uddg=')) {
      try {
        const uddg = new URL('https:' + matchedUrl).searchParams.get('uddg');
        if (uddg) matchedUrl = decodeURIComponent(uddg);
      } catch {
        continue;
      }
    }

    if (title && matchedUrl && !matchedUrl.includes('duckduckgo.com')) {
      try {
        results.push({
          title,
          url: matchedUrl,
          snippet: '',
          source: new URL(matchedUrl).hostname,
        });
      } catch {
        // 跳过无效 URL
      }
    }
  }

  return results;
}

// HTTP GET 请求封装
function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;

    const req = protocol.request(url, {
      method: 'GET',
      headers: headers,
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.end();
  });
}
