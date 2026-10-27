import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApp, networkUrls } from '../server.js';

let upstream;
let app;
let protectedApp;
let base;
let protectedBase;
let received;
let upstreamMode = 'normal';
let upstreamStopped;

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
before(async () => {
  upstream = http.createServer(async (req, res) => {
    if (upstreamMode === 'error') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'model not found' }));
    }
    if (req.url === '/api/tags') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ models: [{ name: 'test:latest', capabilities: ['completion'] }] }));
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('Content-Type', 'application/x-ndjson');
    if (received.model === 'test:slow') {
      res.once('close', () => upstreamStopped());
      res.write(JSON.stringify({ message: { content: 'Starting' }, done: false }) + '\n');
      return;
    }
    res.write(JSON.stringify({ message: { role: 'assistant', thinking: 'A thought.' }, done: false }) + '\n');
    res.write(JSON.stringify({ message: { role: 'assistant', content: 'Hello, ' }, done: false }) + '\n');
    res.end(JSON.stringify({ message: { role: 'assistant', content: 'world!' }, done: true }) + '\n');
  });
  const ollamaUrl = await listen(upstream);
  app = createApp({ ollamaUrl, password: '' });
  protectedApp = createApp({ ollamaUrl, password: 'a-long-test-password', secureCookie: true });
  base = await listen(app);
  protectedBase = await listen(protectedApp);
});
after(async () => {
  await Promise.all([app, protectedApp, upstream].map(server => new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()))));
});
const payload = { model: 'test:latest', messages: [{ role: 'user', content: 'Hi' }], temperature: 0.7 };
function post(url, body, headers = {}) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
test('serves app assets with security headers and no arbitrary file access', async () => {
  for (const path of ['/', '/app.js', '/styles.css', '/favicon.svg']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.equal((await fetch(base + '/server.js')).status, 404);
  assert.equal((await fetch(base + '/.env')).status, 404);
});
test('discovers models from the configured Ollama server', async () => {
  const response = await fetch(base + '/api/models');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).models[0].name, 'test:latest');
});
test('streams Ollama content and thinking and forwards only supported options', async () => {
  const response = await post(base + '/api/chat', { ...payload, arbitrary: 'ignored' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /ndjson/);
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.map(e => e.message.content || '').join(''), 'Hello, world!');
  assert.equal(events[0].message.thinking, 'A thought.');
  assert.equal(events.at(-1).done, true);
  assert.deepEqual(received, { model: 'test:latest', messages: payload.messages, stream: true, options: { temperature: 0.7 } });
});
test('cancels the upstream generation when the browser stops its request', async () => {
  const stopped = new Promise(resolve => { upstreamStopped = resolve; });
  const controller = new AbortController();
  const response = await fetch(base + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, model: 'test:slow' }),
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /Starting/);
  controller.abort();
  let timeout;
  try {
    await Promise.race([stopped, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Upstream request was not cancelled.')), 3000);
    })]);
  } finally { clearTimeout(timeout); }
});
test('rejects invalid messages, temperatures, JSON and oversized bodies', async () => {
  for (const body of [null, {}, { ...payload, messages: [] }, { ...payload, temperature: 3 },
    { ...payload, temperature: '0.7' }, { ...payload, messages: [{ role: 'tool', content: 'bad' }] }]) {
    assert.equal((await post(base + '/api/chat', body)).status, 400);
  }
  assert.equal((await fetch(base + '/api/chat', { method: 'POST', body: '{bad' })).status, 400);
  assert.equal((await post(base + '/api/chat', { ...payload, messages: [{ role: 'user', content: 'x'.repeat(1_048_576) }] })).status, 413);
});
test('rejects cross-origin requests even without a password', async () => {
  assert.equal((await post(base + '/api/chat', payload, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await post(base + '/api/chat', payload, { Origin: base })).status, 200);
});
test('requires authentication and supports login, session and logout', async () => {
  assert.equal((await fetch(protectedBase + '/api/models')).status, 401);
  assert.equal((await post(protectedBase + '/api/chat', payload)).status, 401);
  assert.equal((await post(protectedBase + '/api/login', { password: 'wrong' })).status, 401);
  const login = await post(protectedBase + '/api/login', { password: 'a-long-test-password' });
  assert.equal(login.status, 200);
  const cookieHeader = login.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly; SameSite=Strict/);
  assert.match(cookieHeader, /Secure/);
  const cookie = cookieHeader.split(';')[0];
  assert.equal((await fetch(protectedBase + '/api/models', { headers: { Cookie: cookie } })).status, 200);
  const session = await (await fetch(protectedBase + '/api/session', { headers: { Cookie: cookie } })).json();
  assert.equal(session.authenticated, true);
  assert.equal((await post(protectedBase + '/api/logout', {}, { Cookie: cookie })).status, 200);
  assert.equal((await fetch(protectedBase + '/api/models', { headers: { Cookie: cookie } })).status, 401);
});
test('limits repeated failed password attempts', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await post(protectedBase + '/api/login', { password: 'wrong' })).status, 401);
  assert.equal((await post(protectedBase + '/api/login', { password: 'a-long-test-password' })).status, 429);
});
test('surfaces upstream model failures', async () => {
  upstreamMode = 'error';
  try {
    const response = await post(base + '/api/chat', payload);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /model not found/);
  } finally { upstreamMode = 'normal'; }
});
test('lists network addresses for the startup message', () => {
  const interfaces = {
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
    'Wi-Fi': [
      { family: 'IPv6', address: 'fe80::1', internal: false },
      { family: 'IPv4', address: '192.168.1.42', internal: false },
    ],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    Ethernet: [{ family: 'IPv4', address: '169.254.10.20', internal: false }],
  };
  assert.deepEqual(networkUrls('0.0.0.0', 3000, interfaces), [
    { url: 'http://192.168.1.42:3000', name: 'Wi-Fi' },
    { url: 'http://172.20.0.1:3000', name: 'vEthernet (WSL)' },
  ]);
  assert.deepEqual(networkUrls('127.0.0.1', 3000, interfaces), []);
  assert.deepEqual(networkUrls('192.168.1.42', 3000, interfaces), [{ url: 'http://192.168.1.42:3000', name: '' }]);
});
