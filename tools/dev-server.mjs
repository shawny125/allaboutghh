#!/usr/bin/env node
/**
 * 로컬 확인용 간단 서버.  node tools/dev-server.mjs  후 http://localhost:3000
 * Vercel 없이도 화면과 API 를 그대로 볼 수 있습니다.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice(5).replace(/[^a-z0-9_-]/gi, '');
    const file = path.join(ROOT, 'api', `${name}.js`);
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `알 수 없는 API: ${name}` }));
      return;
    }
    const handler = require(file);
    req.query = Object.fromEntries(url.searchParams);
    res.status = (s) => { res.statusCode = s; return res; };
    res.send = (b) => { res.end(b); return res; };
    await handler(req, res);
    return;
  }

  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('찾을 수 없습니다');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

server.listen(PORT, () => {
  console.log(`http://localhost:${PORT} 에서 확인하세요.`);
  console.log('연결 점검은 /api/school 부터 열어 보세요.');
});
