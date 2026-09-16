#!/usr/bin/env bash
# ============================================================================
# companion-relay-deploy.sh — 把生产 companion relay 部署到阿里云上海 ECS。
#
# 流程：本机 esbuild 出单文件 bundle（凭据/ws/zod 全部打进产物，远端只需要
# Node）→ scp 到 /opt/neo-relay → 写 /etc/neo-relay/relay.env（600，neorelay 属主）
# → 安装 systemd unit（开机自启 + 崩溃重启 + journald）→ healthz 验活。
# 幂等，可重复跑；凭据首次生成后落 ~/.ship/secrets/neo-relay-credential（600），
# 之后的启用（Host 侧 companion-relay.json + 钥匙串）由编排接管。
#
# 边界：服务只听 127.0.0.1；不动安全组/防火墙/DNS，不装反代（编排的活）。
# 用法：scripts/deploy/companion-relay-deploy.sh
#   NEO_RELAY_SSH_HOST  缺省 root@8.153.206.118
#   NEO_RELAY_PORT      缺省 8791
# ============================================================================
set -euo pipefail

REMOTE_HOST="${NEO_RELAY_SSH_HOST:-root@8.153.206.118}"
REMOTE_PORT="${NEO_RELAY_PORT:-8791}"
REMOTE_APP_DIR=/opt/neo-relay
REMOTE_ENV_DIR=/etc/neo-relay
LOCAL_SECRET="${NEO_RELAY_CREDENTIAL_FILE:-$HOME/.ship/secrets/neo-relay-credential}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "==> building relay bundle at $(git rev-parse --short HEAD)"
npm run build:relay
BUNDLE="dist/relay/neo-companion-relay.cjs"
[[ -s "$BUNDLE" ]] || { echo "bundle missing: $BUNDLE" >&2; exit 1; }
SHA256="$(shasum -a 256 "$BUNDLE" | awk '{print $1}')"
echo "==> bundle sha256=$SHA256"

if [[ ! -s "$LOCAL_SECRET" ]]; then
  mkdir -p "$(dirname "$LOCAL_SECRET")"
  (umask 077 && openssl rand -base64 32 > "$LOCAL_SECRET.new" && mv "$LOCAL_SECRET.new" "$LOCAL_SECRET")
  echo "==> generated new relay credential at $LOCAL_SECRET (600)"
fi
chmod 600 "$LOCAL_SECRET"
CREDENTIAL="$(<"$LOCAL_SECRET")"
(( ${#CREDENTIAL} >= 16 )) || { echo "credential shorter than 16 chars: $LOCAL_SECRET" >&2; exit 1; }

echo "==> provisioning $REMOTE_HOST (user, dirs, node check)"
ssh "$REMOTE_HOST" REMOTE_APP_DIR="$REMOTE_APP_DIR" REMOTE_ENV_DIR="$REMOTE_ENV_DIR" bash -s <<'REMOTE'
set -euo pipefail
[[ -x /usr/local/bin/node ]] || { echo "/usr/local/bin/node missing" >&2; exit 1; }
/usr/local/bin/node -v
id -u neorelay >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin neorelay
install -d -o neorelay -g neorelay -m 750 "$REMOTE_APP_DIR" "$REMOTE_ENV_DIR"
REMOTE

echo "==> shipping bundle"
scp -q "$BUNDLE" "$REMOTE_HOST:$REMOTE_APP_DIR/neo-companion-relay.cjs.new"
ssh "$REMOTE_HOST" REMOTE_APP_DIR="$REMOTE_APP_DIR" SHA256="$SHA256" bash -s <<'REMOTE'
set -euo pipefail
echo "$SHA256  $REMOTE_APP_DIR/neo-companion-relay.cjs.new" | sha256sum -c -
chown neorelay:neorelay "$REMOTE_APP_DIR/neo-companion-relay.cjs.new"
chmod 0644 "$REMOTE_APP_DIR/neo-companion-relay.cjs.new"
mv -f "$REMOTE_APP_DIR/neo-companion-relay.cjs.new" "$REMOTE_APP_DIR/neo-companion-relay.cjs"
REMOTE

echo "==> writing env file (credential via stdin pipe, never in argv)"
# 注意：不能把 printf 管道和 heredoc 混在同一个 ssh 上——heredoc 会抢占 stdin，
# 远端 cat 会把剩余脚本吃掉（首版部署实测：relay.env 没落地、unit 起不来）。
# 所以这里用独立的 ssh 连接，env 内容走 /dev/stdin 管道。
printf 'NEO_RELAY_PORT=%s\nNEO_RELAY_BIND=127.0.0.1\nNEO_RELAY_CREDENTIAL=%s\n' "$REMOTE_PORT" "$CREDENTIAL" \
  | ssh "$REMOTE_HOST" "install -o neorelay -g neorelay -m 0600 /dev/stdin $REMOTE_ENV_DIR/relay.env.new"
ssh "$REMOTE_HOST" REMOTE_ENV_DIR="$REMOTE_ENV_DIR" bash -s <<'REMOTE'
set -euo pipefail
if cmp -s "$REMOTE_ENV_DIR/relay.env.new" "$REMOTE_ENV_DIR/relay.env"; then
  rm -f "$REMOTE_ENV_DIR/relay.env.new"; echo "env unchanged"
else
  mv -f "$REMOTE_ENV_DIR/relay.env.new" "$REMOTE_ENV_DIR/relay.env"; echo "env updated"
fi
REMOTE

echo "==> installing systemd unit"
scp -q packages/relay/deploy/neo-companion-relay.service "$REMOTE_HOST:/etc/systemd/system/neo-companion-relay.service"
ssh "$REMOTE_HOST" REMOTE_PORT="$REMOTE_PORT" bash -s <<'REMOTE'
set -euo pipefail
systemctl daemon-reload
systemctl enable neo-companion-relay.service >/dev/null
systemctl restart neo-companion-relay.service
# 先清上轮残留：否则本轮 curl 全失败时旧的 /tmp/relay-healthz.json 仍非空，验活假绿。
rm -f /tmp/relay-healthz.json
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$REMOTE_PORT/healthz" >/tmp/relay-healthz.json 2>/dev/null; then
    echo "healthz: $(cat /tmp/relay-healthz.json)"
    break
  fi
  sleep 0.5
done
[[ -s /tmp/relay-healthz.json ]] || { journalctl -u neo-companion-relay -n 30 --no-pager; exit 1; }
systemctl is-active neo-companion-relay.service
ss -ltn | grep "127.0.0.1:$REMOTE_PORT"
REMOTE

echo "==> deploy receipt"
echo "host=$REMOTE_HOST port=$REMOTE_PORT sha256=$SHA256"
echo "unit=packages/relay/deploy/neo-companion-relay.service credential=$LOCAL_SECRET (Host 启用时由编排写入钥匙串 dev.neo.companion.relay.v1)"
