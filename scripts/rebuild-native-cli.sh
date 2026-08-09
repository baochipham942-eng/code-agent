#!/bin/bash
# ============================================================================
# rebuild-native-cli.sh - 验证 Node.js CLI 的 better-sqlite3 运行时
# ============================================================================
# 使用方法: npm run rebuild-native:cli
#
# better-sqlite3 v13 已迁移到 Node-API，并随包提供平台预编译文件；CLI 不再需要
# 维护一份按 NODE_MODULE_VERSION 区分的 better_sqlite3_cli.node。
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

node <<'NODE'
const Database = require('better-sqlite3');
const db = new Database(':memory:');
const row = db.prepare('SELECT 1 AS ok').get();
db.close();
if (row.ok !== 1) throw new Error('better-sqlite3 CLI smoke returned an unexpected result');
console.log(`better-sqlite3 CLI Node-API smoke passed on ${process.version}`);
NODE
