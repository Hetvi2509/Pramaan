// Run: node tests/forensics.integration.cjs (isolated SQLite + storage; no user cases touched).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
const python = path.join(root, 'engine/.venv/Scripts/python.exe');
const work = fs.mkdtempSync(path.join(root, 'test-assets/integration-'));
const db = path.join(work, 'test.db');
execFileSync(python, ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(open(sys.argv[2]).read()); c.close()', db,
  path.join(root, 'prisma/migrations/20260929152612_init/migration.sql')]);

async function main() {
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const server = spawn(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'src/index.ts'], {
    cwd: root, windowsHide: true, env: { ...process.env, PORT: String(port), DATABASE_URL: `file:${db.replaceAll('\\', '/')}`, STORAGE_DIR: work },
  });
  let logs = ''; server.stdout.on('data', b => logs += b); server.stderr.on('data', b => logs += b);
  const base = `http://127.0.0.1:${port}`;
  let token;
  const request = async (url, body, method = 'POST', auth = token) => {
    const response = await fetch(base + url, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
    const data = await response.json(); assert.equal(response.ok, true, JSON.stringify(data)); return data;
  };
  const waitTask = async (id, success = true) => {
    const response = await fetch(`${base}/api/tasks/${id}/stream?token=${token}`, { signal: AbortSignal.timeout(60000) });
    assert.equal(response.status, 200);
    const text = await response.text();
    const events = text.split('\n\n').filter(Boolean).map(block => ({ channel: block.split('\n')[0].slice(7), data: JSON.parse(block.split('\n')[1].slice(6)) }));
    const complete = events.find(e => e.channel === 'complete');
    assert.equal(complete?.data.success, success, text);
    return events.find(e => e.data?.type === 'forensics_result')?.data.data;
  };
  try {
    for (let n = 0; n < 100; n++) {
      if (server.exitCode !== null) throw new Error(logs);
      try { if ((await fetch(base + '/api/health')).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    token = (await request('/api/auth/signup', { username: 'integration', email: 'integration@example.test', password: 'local-test-password' })).token;
    const caseId = (await request('/api/cases', { name: 'Isolated integration test' })).data.id;
    const upload = async (filename, contents) => {
      const form = new FormData(); form.append('file', new Blob([contents]), filename);
      return (await request(`/api/cases/${caseId}/images`, form)).data;
    };
    const image = await upload('motion.avi', fs.readFileSync(path.join(root, 'test-assets/motion_test.avi')));
    const run = async (action, body = {}, success = true, id = image.id) => {
      const task = await request(`/api/images/${id}/tasks/${action}`, body);
      return waitTask(task.taskId, success);
    };
    assert.equal((await run('hash')).scope, 'file bytes');
    assert.equal((await run('identify')).container, 'AVI');
    const parsed = await run('parse'); assert.equal(parsed.recordings.length, 1);
    const stored = (await request(`/api/images/${image.id}/forensics`, undefined, 'GET')).data;
    assert.equal(stored.integrity.matches, true); assert.ok(stored.intake_hashes.md5); assert.ok(stored.parsed_bundle);
    const output = await run('extract', { recordingId: '0' }); assert.ok(fs.existsSync(output.output));
    const media = await fetch(`${base}/api/outputs/file?path=${encodeURIComponent(output.output)}&token=${token}`);
    assert.equal(media.status, 200); assert.ok((await media.arrayBuffer()).byteLength > 100);
    const otherToken = (await request('/api/auth/signup', { username: 'other', email: 'other@example.test', password: 'local-test-password' })).token;
    const denied = await fetch(`${base}/api/images/${image.id}/tasks/parse`, { method: 'POST', headers: { Authorization: `Bearer ${otherToken}` } });
    assert.equal(denied.status, 403);
    const ownTask = await request(`/api/images/${image.id}/tasks/identify`, {});
    assert.equal((await fetch(`${base}/api/tasks/${ownTask.taskId}/stream?token=${otherToken}`)).status, 403);
    await waitTask(ownTask.taskId);
    const unknown = await upload('unknown.img', Buffer.from('unrecognized disk layout'));
    await run('parse', {}, false, unknown.id);
    // Modify only this test's own isolated upload, then verify mismatch detection.
    assert.ok(path.resolve(image.path_on_disk).startsWith(work + path.sep));
    fs.appendFileSync(image.path_on_disk, 'tamper test');
    await run('hash');
    assert.equal((await request(`/api/images/${image.id}/forensics`, undefined, 'GET')).data.integrity.matches, false);
    const png = path.join(work, 'small.png');
    execFileSync(python, ['-c', 'import cv2,numpy as np,sys; cv2.imwrite(sys.argv[1],np.zeros((20,40,3),np.uint8))', png]);
    const form = new FormData(); form.append('file', new Blob([fs.readFileSync(png)]), 'small.png');
    const uploaded = await request('/api/uploads', form);
    const upTask = await request('/api/tasks/upscale-image', { image: uploaded.path, scale: 2, outputDir: work });
    const enlarged = await waitTask(upTask.taskId); assert.equal(enlarged.width, 80); assert.equal(enlarged.height, 40);
    console.log('PASS: upload hashes, media hashing, identification, parsing, persistence, extraction, H.264 preview, ownership, unknown-format failure, tamper detection, image upscaling.');
    console.log('Isolated test artifacts: ' + work);
  } finally {
    // Kill only the server created by this test, including its tsx child.
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/pid', String(server.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    } else server.kill();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 });
