'use strict';

const assert = require('node:assert/strict');

async function verifyNodePty() {
  const pty = require('node-pty');
  const terminal = pty.spawn('/bin/sh', ['-lc', 'printf node-pty-ok'], {
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    env: process.env,
  });
  let output = '';
  terminal.onData((chunk) => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('node-pty smoke timed out')), 5_000);
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode === 0) resolve();
      else reject(new Error(`node-pty exited with ${exitCode}`));
    });
  });
  assert.match(output, /node-pty-ok/);
}

async function main() {
  assert.equal(process.platform, 'linux', 'native runtime smoke must execute on Linux');
  assert.equal(process.arch, 'x64', 'native runtime smoke must execute on x64');

  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  assert.deepEqual(db.prepare('SELECT 1 AS ok').get(), { ok: 1 });
  db.close();

  const sharp = require('sharp');
  const image = await sharp({
    create: { width: 1, height: 1, channels: 4, background: '#000000' },
  }).png().toBuffer();
  assert.ok(image.length > 0);

  await verifyNodePty();

  console.log(JSON.stringify({
    platform: `${process.platform}-${process.arch}`,
    betterSqlite3: require('better-sqlite3/package.json').version,
    nodePty: require('node-pty/package.json').version,
    sharp: sharp.versions.sharp,
    result: 'native-runtime-ok',
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
