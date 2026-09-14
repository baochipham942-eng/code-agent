// ============================================================================
// egressPrecheck — ADR-066 D5 刀 0：bash 出网命令文本预检
//
// 字面 host 命中私网/环回/链路本地/元数据 → private-host；网络命令在场而目的地
// 文本不可解析（$VAR/$(...)/管道喂入/curl -K/套娃超深/parser 失败）→ unresolvable。
// 良性公网命令与非网络命令必须返回 null（不株连）。
// ============================================================================

import { describe, it, expect } from 'vitest';
import { assessEgressPrecheck } from '../../src/host/security/egressPrecheck';

describe('assessEgressPrecheck', () => {
  describe('字面 URL/host 命中私网 → private-host', () => {
    const cases: Array<[string, string, string]> = [
      // [command, tool, host]
      ['curl http://169.254.169.254/', 'curl', '169.254.169.254'],
      ['curl http://169.254.169.254/latest/meta-data', 'curl', '169.254.169.254'],
      ['curl http://10.0.0.5/', 'curl', '10.0.0.5'],
      ['curl http://127.0.0.1:8080/health', 'curl', '127.0.0.1'],
      ['curl http://[::1]/', 'curl', '[::1]'],
      ['curl http://metadata.google.internal/latest', 'curl', 'metadata.google.internal'],
      ['curl http://instance-data/latest', 'curl', 'instance-data'],
      ['wget http://169.254.169.254/latest/meta-data', 'wget', '169.254.169.254'],
      ['nc 192.168.1.10 443', 'nc', '192.168.1.10'],
      ['ncat 10.1.2.3 22', 'ncat', '10.1.2.3'],
      ['netcat 172.16.0.9 80', 'netcat', '172.16.0.9'],
      ['nc ::1 80', 'nc', '::1'],
      ['ssh user@172.16.0.9 uptime', 'ssh', '172.16.0.9'],
      ['ssh -p 2222 user@10.0.0.2', 'ssh', '10.0.0.2'],
      ['scp ./f.txt user@169.254.169.254:/tmp/', 'scp', '169.254.169.254'],
      ['curl --url http://169.254.169.254/', 'curl', '169.254.169.254'],
    ];
    for (const [command, tool, host] of cases) {
      it(command, () => {
        expect(assessEgressPrecheck(command)).toEqual({ kind: 'private-host', tool, host });
      });
    }
  });

  describe('wrapper 解包与同行赋值', () => {
    it("一层 bash -c 'curl http://…'", () => {
      expect(assessEgressPrecheck("bash -c 'curl http://169.254.169.254/'"))
        .toEqual({ kind: 'private-host', tool: 'curl', host: '169.254.169.254' });
    });
    it('sudo / command / env 包裹', () => {
      expect(assessEgressPrecheck('sudo curl http://169.254.169.254/'))
        .toEqual({ kind: 'private-host', tool: 'curl', host: '169.254.169.254' });
      expect(assessEgressPrecheck('command curl http://127.0.0.1/'))
        .toEqual({ kind: 'private-host', tool: 'curl', host: '127.0.0.1' });
      expect(assessEgressPrecheck('env FOO=bar curl http://169.254.169.254/'))
        .toEqual({ kind: 'private-host', tool: 'curl', host: '169.254.169.254' });
    });
    it('同行赋值 URL=http://… curl $URL（parser 看得到字面则抽）', () => {
      expect(assessEgressPrecheck('URL=http://169.254.169.254 curl $URL'))
        .toEqual({ kind: 'private-host', tool: 'curl', host: '169.254.169.254' });
      expect(assessEgressPrecheck('URL=http://169.254.169.254 curl ${URL}'))
        .toEqual({ kind: 'private-host', tool: 'curl', host: '169.254.169.254' });
    });
  });

  describe('良性公网 / 非网络命令 → null', () => {
    const benign = [
      'curl https://example.com',
      'curl -sS -H "Accept: application/json" https://api.example.com/v1',
      // 本地代理是选项值不是目的地，不能误报私网
      'curl -x http://127.0.0.1:7897 https://example.com',
      // header 值里的变量不是目的地
      'curl -H "Authorization: $TOKEN" https://example.com',
      'curl --version',
      'wget https://example.com/file.tar.gz',
      'nc -l 8080',
      'ssh user@example.com uptime',
      // 长得像元数据 IP 的公网域名不能过杀
      'curl http://169.254.169.254.evil.com/',
      'ls -la',
      'git status',
      'echo "curl $(date)"',
      'bash deploy.sh',
      // python/node 不在抽取名单（ADR-066 D5 明示的刀 0 边界，归沙盒层管）
      'python3 -c "import urllib.request"',
    ];
    for (const command of benign) {
      it(command, () => {
        expect(assessEgressPrecheck(command)).toBeNull();
      });
    }
  });

  describe('目的地文本不可解析 → unresolvable-target（偏严）', () => {
    it('变量展开 curl $URL', () => {
      expect(assessEgressPrecheck('curl $URL'))
        .toEqual({ kind: 'unresolvable-target', tool: 'curl' });
    });
    it('命令替换 curl $(cat url.txt)', () => {
      expect(assessEgressPrecheck('curl $(cat url.txt)'))
        .toEqual({ kind: 'unresolvable-target', tool: 'curl' });
    });
    it('目标位混有命令替换——公网目标已解析仍偏严升级', () => {
      // $(date) 展开结果是 curl 的第二个 URL，文本不可见，偏严不豁免
      expect(assessEgressPrecheck('curl https://example.com $(date)'))
        .toEqual({ kind: 'unresolvable-target', tool: 'curl' });
    });
    it('管道喂入 echo http://169.254.169.254 | xargs curl', () => {
      expect(assessEgressPrecheck('echo http://169.254.169.254 | xargs curl'))
        .toEqual({ kind: 'unresolvable-target', tool: 'curl' });
    });
    it('curl -K/--config 配置文件', () => {
      expect(assessEgressPrecheck('curl -K curlrc.txt'))
        .toEqual({ kind: 'unresolvable-target', tool: 'curl' });
      expect(assessEgressPrecheck('curl --config=curlrc.txt'))
        .toEqual({ kind: 'unresolvable-target', tool: 'curl' });
    });
    it('wrapper 套娃超深（bash -c 五层，parser 深度 4 之外）', () => {
      let command = 'curl http://169.254.169.254/';
      for (let layer = 0; layer < 5; layer += 1) command = `bash -c ${JSON.stringify(command)}`;
      const finding = assessEgressPrecheck(command);
      expect(finding).toEqual({ kind: 'unresolvable-target', tool: 'curl' });
    });
    it('parser uncertain 且网络命令在场', () => {
      // `chronic bash -c …` 触发 unknown-shell-launcher，内层 curl 无法干净解析
      expect(assessEgressPrecheck("chronic bash -c 'curl $URL'"))
        .toEqual({ kind: 'unresolvable-target', tool: 'curl' });
    });
  });

  describe('已干净解析公网目的地的网络命令不被别段的解析失败株连', () => {
    it('bash deploy.sh && curl https://example.com — uncertain 来自别段，curl 目标已解析 → null', () => {
      expect(assessEgressPrecheck('bash deploy.sh && curl https://example.com')).toBeNull();
    });
  });
});
