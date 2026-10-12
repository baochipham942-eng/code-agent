import { createServer, type Server } from 'node:http';
import { COMPANION_LIMITS as L } from '../../../shared/constants/companion';
import { isLanPeer } from '../../../shared/companion/lanProtocol';

/**
 * 总闸关闭期间顶在 LAN 端口上的最小应答器（N-COMPANION-KILLSWITCH-WIRE）：对**每一个**
 * 请求回同一份固定字节（403 + `{"error":"COMPANION_REMOTE_OFF"}`），让手机分得清
 * 「电脑关了远程」和「电脑不可达」，而不是一律当断网无限重试。
 *
 * 与请求内容零相关是契约：不解析、不读 body、不携带任何设备信息——因此本文件不 import
 * gateway/Noise/session/invitation 里的任何东西（结构上就不存在通向它们的路径，由
 * tests/integration/companion/remoteOffResponder.test.ts 的源码断言钉住）。
 */
const FIXED_BODY = '{"error":"COMPANION_REMOTE_OFF"}';

/** Dedicated off-answer surface: no express, no body parsing, no secrets — fixed bytes only. */
export class RemoteOffResponder {
  private server: Server | null = null;
  private listenPort = 0;

  /** 此刻实际监听的端口（未监听为 0）；manager 用它决定下一次在哪个端口顶班。 */
  get port(): number { return this.listenPort; }

  async start(port: number = L.lanPort): Promise<void> {
    if (this.server) return;
    const server = createServer((_req, res) => {
      if (res.destroyed) return;
      // 任何 method/path/header/body 都是同一份答案：请求体停在 parser 的暂停态，绝不解析、
      // 缓冲或消费。应答落盘后只关写侧；客户端能收到完整答案，连接随即结束，而大 body
      // 不会把拒绝面拖进业务层。
      res.writeHead(403, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'content-length': String(Buffer.byteLength(FIXED_BODY)),
      });
      res.end(FIXED_BODY, () => { res.socket?.end(); });
    });
    server.requestTimeout = L.requestTimeoutMs;
    server.headersTimeout = L.requestTimeoutMs;
    server.maxConnections = L.maxChannels * 2;
    // 同真服务：非私网对端在 TCP 层直接断，不给它顶着 maxConnections 占坑的机会。
    server.on('connection', socket => {
      if (!isLanPeer(socket.remoteAddress?.replace(/^::ffff:/, '') ?? '')) socket.destroy();
    });
    const listenAt = (at: number) => new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(at, () => { server.off('error', reject); resolve(); });
    });
    try {
      await listenAt(port);
    } catch (error) {
      // 同机多张 Host 脸会抢端口（见 LanCompanionServer.start 的同款处理）：先来的常驻，
      // 后到的换临时端口。总闸关着时手机拿的是旧端点，这里换了端口它确实够不到——
      // 但比起让关闸动作整个失败，留痕 + 临时端口是更小的坏事。
      if ((error as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw error;
      console.warn(`[companion] remote-off responder port ${port} already in use; falling back to an ephemeral port`);
      await listenAt(0);
    }
    this.server = server;
    this.listenPort = (server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.listenPort = 0;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
