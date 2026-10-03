/**
 * =============================================================================
 *  AnchorMC Launcher — minimal backend (zero dependencies)
 * =============================================================================
 *  Powers two admin-panel features that a single desktop app can't do on
 *  its own, because they need a shared point every copy of the launcher can
 *  talk to:
 *
 *    1. "Aktif oyuncular" — every running launcher sends a small heartbeat
 *       every ~60s. /api/stats reports how many are currently active.
 *    2. News management — admin panel can list/add/delete news articles,
 *       which every launcher then reads from /api/news instead of the
 *       bundled news/news.json.
 *
 *  Deploy this ANYWHERE that can run `node index.js` (Render, Railway, a
 *  VPS, your own PC with port-forwarding...). See ../DEPLOY-BACKEND.md for
 *  step-by-step instructions. It uses only Node's built-in modules — no
 *  `npm install` needed, no database to set up.
 *
 *  Data is stored in ./data/*.json next to this file. Simple by design —
 *  this is meant for hundreds/thousands of installs, not millions.
 * =============================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
// Change this (or set the ADMIN_KEY environment variable on your host) —
// it should match whatever you'll type into the launcher's admin panel.
const ADMIN_KEY = process.env.ADMIN_KEY || 'nexora';
const ACTIVE_WINDOW_MS = 3 * 60 * 1000; // "active" = heartbeat within the last 3 minutes

const DATA_DIR = path.join(__dirname, 'data');
const INSTALLS_FILE = path.join(DATA_DIR, 'installs.json');
const NEWS_FILE = path.join(DATA_DIR, 'news.json');
const RELEASE_META_FILE = path.join(DATA_DIR, 'release.json');
const RELEASES_DIR = path.join(DATA_DIR, 'releases');
if (!fs.existsSync(RELEASES_DIR)) fs.mkdirSync(RELEASES_DIR, { recursive: true });

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let installs = loadJson(INSTALLS_FILE, {}); // { [installId]: { username, firstSeen, lastSeen } }
let news = loadJson(NEWS_FILE, []); // [{ id, type, title, summary, date, link }]
let releaseMeta = loadJson(RELEASE_META_FILE, null); // { version, filename, sha512, size, releaseDate }

function countActive() {
  const now = Date.now();
  return Object.values(installs).filter((i) => now - i.lastSeen < ACTIVE_WINDOW_MS).length;
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy(); // 1MB guard
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function isAdmin(req) {
  return req.headers['x-admin-key'] === ADMIN_KEY;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === 'OPTIONS') return send(res, 204, {});

  // ---- Releases: upload a new build (raw binary body, streamed to disk) ----
  // Not wrapped in the try/catch JSON flow below since it streams a large
  // binary body and responds itself.
  if (pathname === '/api/releases' && req.method === 'POST') {
    if (!isAdmin(req)) return send(res, 401, { error: 'unauthorized' });
    const version = url.searchParams.get('version');
    if (!version) return send(res, 400, { error: 'version query param required' });

    const filename = 'AnchorMC-Launcher-Setup.exe';
    const finalPath = path.join(RELEASES_DIR, filename);
    const tmpPath = `${finalPath}.uploading`;
    const hash = crypto.createHash('sha512');
    let size = 0;
    const writeStream = fs.createWriteStream(tmpPath);

    req.on('data', (chunk) => {
      hash.update(chunk);
      size += chunk.length;
    });
    req.on('error', () => {
      writeStream.destroy();
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    });
    req.pipe(writeStream);

    writeStream.on('finish', () => {
      fs.renameSync(tmpPath, finalPath);
      releaseMeta = {
        version,
        filename,
        sha512: hash.digest('base64'),
        size,
        releaseDate: new Date().toISOString()
      };
      saveJson(RELEASE_META_FILE, releaseMeta);
      send(res, 200, { ok: true, ...releaseMeta });
    });
    writeStream.on('error', (err) => send(res, 500, { error: err.message }));
    return;
  }

  // ---- Releases: electron-updater's generic-provider feed ------------------
  if (pathname === '/api/releases/latest.yml' && req.method === 'GET') {
    if (!releaseMeta) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('no release published yet');
      return;
    }
    const yml = [
      `version: ${releaseMeta.version}`,
      'files:',
      `  - url: ${releaseMeta.filename}`,
      `    sha512: ${releaseMeta.sha512}`,
      `    size: ${releaseMeta.size}`,
      `path: ${releaseMeta.filename}`,
      `sha512: ${releaseMeta.sha512}`,
      `releaseDate: '${releaseMeta.releaseDate}'`,
      ''
    ].join('\n');
    res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(yml);
    return;
  }

  // ---- Releases: current published version (for the admin panel) ----------
  if (pathname === '/api/releases/info' && req.method === 'GET') {
    return send(res, 200, { release: releaseMeta });
  }

  // ---- Releases: serve the installer binary (with Range support) ----------
  if (pathname.startsWith('/api/releases/') && req.method === 'GET') {
    const filename = decodeURIComponent(pathname.replace('/api/releases/', ''));
    const filePath = path.join(RELEASES_DIR, filename);
    if (!filePath.startsWith(RELEASES_DIR) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'application/octet-stream',
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(filePath).pipe(res);
    }
    return;
  }

  try {
    // ---- Heartbeat -------------------------------------------------------
    if (pathname === '/api/heartbeat' && req.method === 'POST') {
      const { installId, username } = await readBody(req);
      if (!installId) return send(res, 400, { error: 'installId required' });
      const now = Date.now();
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      installs[installId] = {
        username: username || installs[installId]?.username || null,
        firstSeen: installs[installId]?.firstSeen || now,
        lastSeen: now,
        ip: ip || installs[installId]?.ip || null,
        heartbeats: (installs[installId]?.heartbeats || 0) + 1
      };
      saveJson(INSTALLS_FILE, installs);
      return send(res, 200, { ok: true, activeInstalls: countActive() });
    }

    // ---- Public stats ------------------------------------------------------
    if (pathname === '/api/stats' && req.method === 'GET') {
      return send(res, 200, {
        activeInstalls: countActive(),
        totalInstalls: Object.keys(installs).length
      });
    }

    // ---- Admin: list installs ---------------------------------------------
    if (pathname === '/api/installs' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 401, { error: 'unauthorized' });
      const list = Object.entries(installs)
        .map(([id, i]) => ({ id, ...i, active: Date.now() - i.lastSeen < ACTIVE_WINDOW_MS }))
        .sort((a, b) => b.lastSeen - a.lastSeen);
      return send(res, 200, {
        installs: list,
        totalInstalls: list.length,
        activeInstalls: list.filter((i) => i.active).length
      });
    }

    // ---- Admin: forget an install (e.g. duplicate/test entries) -----------
    if (pathname.startsWith('/api/installs/') && req.method === 'DELETE') {
      if (!isAdmin(req)) return send(res, 401, { error: 'unauthorized' });
      const id = pathname.split('/').pop();
      const existed = id in installs;
      delete installs[id];
      saveJson(INSTALLS_FILE, installs);
      return send(res, 200, { deleted: existed });
    }

    // ---- News: public read --------------------------------------------------
    if (pathname === '/api/news' && req.method === 'GET') {
      return send(res, 200, { articles: [...news].sort((a, b) => (a.date < b.date ? 1 : -1)) });
    }

    // ---- News: admin add ---------------------------------------------------
    if (pathname === '/api/news' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      if (!body.title) return send(res, 400, { error: 'title required' });
      const article = {
        id: crypto.randomUUID(),
        type: body.type || 'update',
        title: body.title,
        summary: body.summary || '',
        date: body.date || new Date().toISOString().slice(0, 10),
        link: body.link || null
      };
      news.push(article);
      saveJson(NEWS_FILE, news);
      return send(res, 201, { article });
    }

    // ---- News: admin update -------------------------------------------------
    if (pathname.startsWith('/api/news/') && req.method === 'PUT') {
      if (!isAdmin(req)) return send(res, 401, { error: 'unauthorized' });
      const id = pathname.split('/').pop();
      const body = await readBody(req);
      const article = news.find((n) => n.id === id);
      if (!article) return send(res, 404, { error: 'not found' });
      if (body.title !== undefined) article.title = body.title;
      if (body.summary !== undefined) article.summary = body.summary;
      if (body.type !== undefined) article.type = body.type;
      if (body.date !== undefined) article.date = body.date;
      if (body.link !== undefined) article.link = body.link;
      saveJson(NEWS_FILE, news);
      return send(res, 200, { article });
    }

    // ---- News: admin delete --------------------------------------------------
    if (pathname.startsWith('/api/news/') && req.method === 'DELETE') {
      if (!isAdmin(req)) return send(res, 401, { error: 'unauthorized' });
      const id = pathname.split('/').pop();
      const before = news.length;
      news = news.filter((n) => n.id !== id);
      saveJson(NEWS_FILE, news);
      return send(res, 200, { deleted: before !== news.length });
    }

    if (pathname === '/' || pathname === '/health') {
      return send(res, 200, { ok: true, service: 'anchormc-launcher-backend' });
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`AnchorMC backend listening on port ${PORT}`);
});
