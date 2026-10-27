import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';

const publicDir = new URL('./public/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_048_576) throw Object.assign(new Error('Request exceeds the 1 MB limit.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw Object.assign(new Error('Invalid JSON request.'), { status: 400 });
  }
}

export function createApp({
  ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  password = process.env.APP_PASSWORD || '',
  secureCookie = process.env.COOKIE_SECURE === 'true',
} = {}) {
  const upstream = new URL(ollamaUrl);
  if (!['http:', 'https:'].includes(upstream.protocol)) throw new Error('OLLAMA_URL must use HTTP or HTTPS.');
  const sessions = new Map();
  const attempts = new Map();
  const digest = value => createHash('sha256').update(value).digest();
  const passwordDigest = digest(password);
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    const path = new URL(req.url, 'http://localhost').pathname;
    try {
      // Reject cross-origin browser requests, including requests to an unprotected local instance.
      if (req.headers.origin) {
        const origin = new URL(req.headers.origin);
        if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) {
          return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
        }
      }
      const now = Date.now();
      for (const [key, expiry] of sessions) if (expiry <= now) sessions.delete(key);
      for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
      const cookie = /(?:^|;\s*)metamorph_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const authenticated = !password || (cookie && sessions.has(cookie));
      if (path === '/api/session' && req.method === 'GET') {
        return json(res, 200, { authenticated: Boolean(authenticated), passwordRequired: Boolean(password) });
      }
      if (path === '/api/login' && req.method === 'POST') {
        const key = req.socket.remoteAddress;
        const entry = attempts.get(key) || { count: 0, until: now + 900_000 };
        if (entry.count >= 10) return json(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
        const body = await readJson(req);
        if (typeof body?.password !== 'string' || !timingSafeEqual(digest(body.password), passwordDigest)) {
          entry.count++;
          attempts.set(key, entry);
          return json(res, 401, { error: 'Incorrect password.' });
        }
        attempts.delete(key);
        const token = randomBytes(32).toString('hex');
        sessions.set(token, now + 86_400_000);
        res.setHeader('Set-Cookie', `metamorph_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secureCookie ? '; Secure' : ''}`);
        return json(res, 200, { authenticated: true });
      }
      if (path.startsWith('/api/') && !authenticated) return json(res, 401, { error: 'Please sign in to continue.' });
      if (path === '/api/logout' && req.method === 'POST') {
        sessions.delete(cookie);
        res.setHeader('Set-Cookie', `metamorph_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
      }
      if (path === '/api/models' && req.method === 'GET') {
        const response = await fetch(new URL('/api/tags', upstream), { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
        const data = await response.json();
        return json(res, 200, { models: data.models || [] });
      }
      if (path === '/api/chat' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body || typeof body.model !== 'string' || !body.model.trim() ||
            !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 500 ||
            !body.messages.every(m => m && ['user', 'assistant', 'system'].includes(m.role) && typeof m.content === 'string') ||
            typeof body.temperature !== 'number' || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2) {
          return json(res, 400, { error: 'Choose a model and provide valid messages and a temperature between 0 and 2.' });
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.on('close', abort);
        const timeout = setTimeout(abort, 600_000);
        try {
          const response = await fetch(new URL('/api/chat', upstream), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: body.model,
              messages: body.messages.map(({ role, content }) => ({ role, content })),
              stream: true,
              options: { temperature: body.temperature },
            }),
            signal: controller.signal,
          });
          if (!response.ok) {
            const detail = await response.json().catch(() => null);
            throw new Error(detail?.error || `Ollama returned HTTP ${response.status}.`);
          }
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' });
          for await (const chunk of response.body) {
            if (res.destroyed) break;
            if (!res.write(chunk)) {
              await new Promise(resolve => {
                const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
                res.once('drain', done);
                res.once('close', done);
              });
            }
          }
          res.end();
        } finally {
          clearTimeout(timeout);
          res.off('close', abort);
        }
        return;
      }
      if (req.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        const content = await readFile(new URL(file, publicDir));
        res.writeHead(200, { 'Content-Type': type });
        return res.end(content);
      }
      json(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (res.destroyed) return;
      console.error(`[metamorph] ${req.method} ${path}: ${error.message}`);
      const message = error.status ? error.message : `Could not complete the request. Check that Ollama is running. ${error.message}`;
      if (res.headersSent) {
        res.end(`${JSON.stringify({ error: message })}\n`);
      } else {
        json(res, error.status || 502, { error: message });
      }
    }
  });
  return server;
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];
const WILDCARD_HOSTS = ['0.0.0.0', '::'];
const VIRTUAL_ADAPTER = /vethernet|virtual|vmware|vbox|docker|wsl|hyper-v|^br-|^veth/i;
const hostUrl = (host, port) => `http://${host.includes(':') ? `[${host}]` : host}:${port}`;

// Addresses other devices on the network can use, real Wi-Fi/Ethernet adapters first.
export function networkUrls(host, port, interfaces = networkInterfaces()) {
  if (LOOPBACK_HOSTS.includes(host)) return [];
  if (!WILDCARD_HOSTS.includes(host)) return [{ url: hostUrl(host, port), name: '' }];
  return Object.entries(interfaces)
    .flatMap(([name, addresses]) => (addresses || [])
      .filter(a => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
      .map(a => ({ url: hostUrl(a.address, port), name })))
    .sort((a, b) => VIRTUAL_ADAPTER.test(a.name) - VIRTUAL_ADAPTER.test(b.name));
}

function readyMessage(host, port) {
  const row = (label, value) => `  ${label.padEnd(19)} ${value}`;
  const lines = ['Metamorph is ready.'];
  if (WILDCARD_HOSTS.includes(host)) lines.push(row('On this computer:', hostUrl('localhost', port)));
  if (LOOPBACK_HOSTS.includes(host)) {
    lines.push(row('On this computer:', hostUrl(host, port)));
    lines.push('  Network access is off. Set HOST=0.0.0.0 in .env to allow other devices.');
    return lines.join('\n');
  }
  const urls = networkUrls(host, port);
  if (!urls.length) lines.push(row('From other devices:', 'no network address found. Is this computer connected?'));
  urls.forEach(({ url, name }, i) => lines.push(row(i ? '' : 'From other devices:', `${url}${name ? `  (${name})` : ''}`)));
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const host = process.env.HOST || '127.0.0.1';
  const password = process.env.APP_PASSWORD || '';
  if (password && password.length < 12) throw new Error('APP_PASSWORD must contain at least 12 characters.');
  if (!LOOPBACK_HOSTS.includes(host) && !password) {
    throw new Error('Set APP_PASSWORD (at least 12 characters) before enabling network access.');
  }
  const server = createApp();
  server.on('error', error => { console.error(`[metamorph] ${error.message}`); process.exitCode = 1; });
  server.listen(Number(process.env.PORT || 3000), host, () => {
    console.log(readyMessage(host, server.address().port));
  });
}
