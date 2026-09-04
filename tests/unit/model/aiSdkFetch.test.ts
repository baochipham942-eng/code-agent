import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const axiosFn = vi.hoisted(() => {
  const fn = vi.fn();
  return Object.assign(fn, { isCancel: vi.fn(() => false) });
});
vi.mock('axios', () => ({ default: axiosFn }));

import { makeAiSdkFetch } from '../../../src/host/model/adapters/aiSdkFetch';

// N-EVAL-CI-NOEXIT：消费方提前停读（abort / 出错）时 Readable.toWeb 只销毁中间 Transform，
// 不顺 pipe 销毁 axios 源响应流——IncomingMessage + zlib + keep-alive socket 常驻事件循环
// （09-02 持有者点名：STREAM_END_OF_STREAM 553 / ZLIB 79）。修复=Transform 关闭时销毁源流。
// 反向变异 M2：删掉 transform.once('close', …) 的销毁 ⇒ 第一个用例红（源流永不销毁）。
describe('aiSdkFetch 响应流收尾（N-EVAL-CI-NOEXIT）', () => {
  it('消费方 cancel web stream 后，底层 axios 响应流被销毁', async () => {
    const source = new Readable({ read() {} }); // 永不结束的源响应流（模型连接挂着没发完的形态）
    axiosFn.mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: source });

    const fetchFn = makeAiSdkFetch();
    const response = await fetchFn('https://api.example.com/v1/chat/completions', { method: 'POST' });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const sourceClosed = new Promise<void>((resolve) => source.once('close', () => resolve()));

    await reader.cancel('consumer stopped');
    await Promise.race([
      sourceClosed,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('source stream not destroyed')), 5000)),
    ]);
    expect(source.destroyed).toBe(true);
  });

  it('正常读完的响应流行为不变：内容完整、不报错', async () => {
    const payload = 'data: {"choices":[]}\n\ndata: [DONE]\n\n';
    const source = Readable.from([Buffer.from(payload)]);
    axiosFn.mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: source });

    const fetchFn = makeAiSdkFetch();
    const response = await fetchFn('https://api.example.com/v1/chat/completions', { method: 'POST' });
    const text = await response.text();
    expect(text).toBe(payload);
  });
});
