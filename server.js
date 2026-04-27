'use strict';

const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const https      = require('https');
const http       = require('http');
const net        = require('net');
const dgram      = require('dgram');
const SftpClient = require('ssh2-sftp-client');

const app = express();

// When running as a packaged .exe, main.js sets PANELS_TMP_DIR to a writable path.
// Falls back to next to server.js for dev mode.
const TMP_DIR = process.env.PANELS_TMP_DIR || path.join(__dirname, 'tmp_uploads');

// Writable data directory (same one Electron uses)
const DATA_DIR = process.env.PANELS_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const AUDIT_PATH = path.join(DATA_DIR, 'audit_logs.json');

function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJsonSafe(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}
function readAudit() { return readJsonSafe(AUDIT_PATH, { dumps: [] }); }
function writeAudit(a) { writeJsonSafe(AUDIT_PATH, a); }

fs.mkdirSync(TMP_DIR, { recursive: true });
const upload = multer({ dest: TMP_DIR });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.status(200).send('ok'));

/* ═══════════════════════════════════════════════════════════════
   BEACON API — https://www.beaconhosting.org/api/v1
     GET    /servers/{id}                    — server info
     POST   /servers/{id}/power              — { signal: start|stop|restart|kill }
     GET    /servers/{id}/console            — logs
     POST   /servers/{id}/console            — send command: { command }
     GET    /servers/{id}/settings/resources — resource usage

   File management is handled entirely via SFTP — not Beacon's API.
   ═══════════════════════════════════════════════════════════════ */
const BEACON_BASE = 'https://www.beaconhosting.org/api/v1';

/* ── Request log ring-buffer ─────────────────────────────────── */
const LOG_MAX = 300;
const reqLog  = [];
function pushLog(e) { reqLog.unshift({ ts: new Date().toISOString(), ...e }); if (reqLog.length > LOG_MAX) reqLog.pop(); }
app.get('/api/logs',    (_q, r) => r.json({ logs: reqLog }));
app.delete('/api/logs', (_q, r) => { reqLog.length = 0; r.json({ cleared: true }); });

/* ── Simple response cache for server data (30s TTL) ─────────── */
const _cache = new Map();
function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > 30000) { _cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) { _cache.set(key, { data, ts: Date.now() }); }
function cacheDel(key) { _cache.delete(key); }


/* ── Error audit dumps (persisted) ───────────────────────────── */
app.get('/api/audit', (_q, r) => r.json(readAudit()));
app.get('/api/audit/:id', (q, r) => {
  const a = readAudit();
  const dump = (a.dumps || []).find(d => d.id === q.params.id);
  if (!dump) return r.status(404).json({ error: 'Not found' });
  r.json({ dump });
});
app.post('/api/audit', (q, r) => {
  const dump = q.body;
  if (!dump || !dump.id) return r.status(400).json({ error: 'dump.id required' });
  const a = readAudit();
  a.dumps = Array.isArray(a.dumps) ? a.dumps : [];
  a.dumps.unshift(dump);
  a.dumps = a.dumps.slice(0, 120);
  writeAudit(a);
  r.json({ saved: true });
});
app.delete('/api/audit', (_q, r) => { writeAudit({ dumps: [] }); r.json({ cleared: true }); });

/* ── Cache wipe (tmp uploads + in-memory logs) ───────────────── */
app.post('/api/cache/wipe', (_q, r) => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(TMP_DIR, { recursive: true });
  reqLog.length = 0;
  r.json({ wiped: true });
});


/* ── Pure-Node HTTPS helper (no node-fetch, no ESM) ─────────── */
function beaconFetch(token, endpoint, opts = {}) {
  return new Promise((resolve, reject) => {
    const url      = BEACON_BASE + endpoint;
    const parsed   = new URL(url);
    const method   = (opts.method || 'GET').toUpperCase();
    const bodyBuf  = opts.body ? Buffer.from(opts.body, 'utf8') : null;
    const t0       = Date.now();
    const logEntry = { source:'beacon', method, url, endpoint, token: token ? token.slice(0,10)+'…':'(none)', status:null, ok:null, ms:null, error:null, responseSnip:null };

    const req = https.request({
      hostname: parsed.hostname,
      port:     Number(parsed.port) || 443,
      path:     parsed.pathname + parsed.search,
      method,
      timeout:  12000,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/json',
        'Content-Type':  'application/json',
        'User-Agent':    'Panels/2.1',
        ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}),
        ...(opts.headers || {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const ms   = Date.now() - t0;
        const text = Buffer.concat(chunks).toString('utf8');
        let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
        const ok   = res.statusCode >= 200 && res.statusCode < 300;
        Object.assign(logEntry, { status: res.statusCode, ok, ms, responseSnip: text.slice(0, 800) });
        pushLog(logEntry);
        console.log(`[Beacon] ${method} ${endpoint} → ${res.statusCode} (${ms}ms)`);
        resolve({ ok, status: res.statusCode, data });
      });
    });

    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', err => {
      Object.assign(logEntry, { ok:false, ms:Date.now()-t0, error:err.message, status:0, responseSnip:err.message });
      pushLog(logEntry);
      console.error(`[Beacon] ${method} ${endpoint} → ERROR: ${err.message}`);
      reject(err);
    });

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/* Unwrap { success, data: {...} } envelope */
function unwrap(r) {
  if (r.data && r.data.data !== undefined) return { ...r, data: r.data.data };
  return r;
}

/* ═══════════════════════════════════════════════════════════════
   SERVERS
   ═══════════════════════════════════════════════════════════════ */
app.get('/api/servers', async (req, res) => {
  const token = req.headers['x-beacon-token'];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const r = unwrap(await beaconFetch(token, '/servers'));
    res.status(r.status).json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/servers/:id', async (req, res) => {
  const token = req.headers['x-beacon-token'];
  if (!token) return res.status(401).json({ error: 'No token' });
  const id = req.params.id.replace(/^\/servers\//, '').replace(/^servers\//, '');
  const cKey = `beacon:srv:${id}`;
  const cached = cacheGet(cKey);
  if (cached) return res.json(cached);
  try {
    const r = unwrap(await beaconFetch(token, `/servers/${id}`));
    if (!r.ok) return res.status(r.status).json(r.data);
    const d = r.data || {};
    const resp = {
      id,
      name:        d.name || d.settings?.meta?.name || id,
      status:      d.status || 'Unknown',
      ip:          d.primaryAllocation?.alias || d.primaryAllocation?.ip || null,
      port:        d.primaryAllocation?.port  || null,
      limits: {
        memory: d.build?.memory_limit ?? null,
        disk:   d.build?.disk_space   ?? null,
        cpu:    d.build?.cpu_limit    ?? null,
      },
      egg:         d.egg?.name || null,
      description: d.description || d.settings?.meta?.description || '',
      uuid:        (d.id || id).replace(/^servers\//, ''),
    };
    cacheSet(cKey, resp);
    res.json(resp);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Power: POST /servers/{id}  body: { action } ──────────────
   Confirmed from docs: POST /servers/{serverId} with action field */
app.post('/api/servers/:id/power', async (req, res) => {
  const token  = req.headers['x-beacon-token'];
  const action = req.body.action;
  if (!token) return res.status(401).json({ error: 'No token' });
  if (!['start','stop','restart','kill'].includes(action))
    return res.status(400).json({ error: 'Invalid action' });
  const id = req.params.id.replace(/^servers\//, '');
  try {
    cacheDel(`beacon:srv:${id}`);
    const r = await beaconFetch(token, `/servers/${id}`, {
      method: 'POST',
      body:   JSON.stringify({ action }),
    });
    res.status(r.status).json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Console logs: GET /servers/{id}/console ──────────────────
   Docs: GET with optional ?size= query param, returns { logs: string[] } */
app.get('/api/servers/:id/logs', async (req, res) => {
  const token = req.headers['x-beacon-token'];
  if (!token) return res.status(401).json({ error: 'No token' });
  const id   = req.params.id.replace(/^servers\//, '');
  const size = req.query.size || 200;
  try {
    const r = unwrap(await beaconFetch(token, `/servers/${id}/console?size=${size}`));
    res.status(r.status).json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Send command: POST /servers/{id}/console  { command } ─── */
app.post('/api/servers/:id/command', async (req, res) => {
  const token   = req.headers['x-beacon-token'];
  if (!token) return res.status(401).json({ error: 'No token' });
  const id = req.params.id.replace(/^servers\//, '');
  try {
    const r = await beaconFetch(token, `/servers/${id}/console`, {
      method: 'POST',
      body:   JSON.stringify({ command: req.body.command }),
    });
    res.status(r.status).json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Resources: GET /servers/{id}/settings/resources ─────────
   Correct endpoint from docs — NOT /resources or /utilization */
app.get('/api/servers/:id/resources', async (req, res) => {
  const token = req.headers['x-beacon-token'];
  if (!token) return res.status(401).json({ error: 'No token' });
  const id = req.params.id.replace(/^servers\//, '');
  try {
    const r = unwrap(await beaconFetch(token, `/servers/${id}/settings/resources`));
    if (!r.ok) return res.status(r.status).json(r.data);
    const d = r.data || {};
    // Normalise across possible response shapes
    res.json({
      cpu_absolute: d.cpu_absolute ?? d.cpu   ?? d.cpuAbsolute ?? 0,
      memory_bytes: d.memory_bytes ?? d.ram   ?? d.memoryBytes ?? 0,
      memory_limit: d.memory_limit ?? d.ram_limit ?? 0,
      disk_bytes:   d.disk_bytes   ?? d.disk  ?? d.diskBytes   ?? 0,
      disk_limit:   d.disk_limit   ?? 0,
      network: {
        rx_bytes: d.network?.rx_bytes ?? d.rx ?? 0,
        tx_bytes: d.network?.tx_bytes ?? d.tx ?? 0,
      },
      state:  d.state  || d.status || null,
      uptime: d.uptime || 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


/* ═══════════════════════════════════════════════════════════════
   MC SERVER LIST PING  (TCP, 1.7+ protocol — no config needed)
   ═══════════════════════════════════════════════════════════════ */
function varint(val) {
  const out = [];
  do { let b = val & 0x7f; val >>>= 7; if (val > 0) b |= 0x80; out.push(b); } while (val > 0);
  return Buffer.from(out);
}
function mcPkt(id, ...parts) {
  const body = Buffer.concat([varint(id), ...parts]);
  return Buffer.concat([varint(body.length), body]);
}

function mcPing(host, port, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket(); let buf = Buffer.alloc(0); let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; sock.destroy(); reject(new Error('Ping timed out')); } }, timeout);
    sock.on('error', e => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      try {
        let off = 0, len = 0, shift = 0, b;
        do { b = buf[off++]; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
        if (buf.length < off + len) return;
        const pkt = buf.slice(off, off + len);
        let po = 0, pid = 0, ps = 0;
        do { b = pkt[po++]; pid |= (b & 0x7f) << ps; ps += 7; } while (b & 0x80);
        if (pid !== 0x00) return;
        let sl = 0, ss = 0;
        do { b = pkt[po++]; sl |= (b & 0x7f) << ss; ss += 7; } while (b & 0x80);
        const json = JSON.parse(pkt.slice(po, po + sl).toString('utf8'));
        if (!done) {
          done = true; clearTimeout(timer); sock.destroy();
          resolve({
            motd:     typeof json.description === 'string' ? json.description : (json.description?.text || ''),
            version:  json.version?.name    || '',
            protocol: json.version?.protocol || 0,
            online:   json.players?.online   || 0,
            max:      json.players?.max      || 0,
            players:  (json.players?.sample  || []).map(p => p.name),
          });
        }
      } catch {}
    });
    sock.connect(port, host, () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2); portBuf.writeUInt16BE(port);
      sock.write(mcPkt(0x00, varint(758), varint(hostBuf.length), hostBuf, portBuf, varint(1)));
      sock.write(mcPkt(0x00));
    });
  });
}

app.get('/api/ping/:id', async (req, res) => {
  const host = req.query.host; const port = parseInt(req.query.port) || 25565;
  if (!host) return res.status(400).json({ error: 'host required' });
  const t0 = Date.now();
  try {
    const data = await mcPing(host, port);
    pushLog({ source:'ping', method:'GET', url:`${host}:${port}`, ok:true, ms:Date.now()-t0, status:200 });
    res.json(data);
  } catch (e) {
    pushLog({ source:'ping', method:'GET', url:`${host}:${port}`, ok:false, error:e.message, ms:Date.now()-t0, status:0 });
    res.status(500).json({ error: e.message });
  }
});


/* ═══════════════════════════════════════════════════════════════
   SFTP  — primary file system (direct SSH, no Beacon API involved)
   ═══════════════════════════════════════════════════════════════ */
const sftpPool = new Map();
const sftpKey  = id => `sftp_${id}`;
// No idle timeout — SFTP connections persist until explicitly disconnected or the process exits.

async function sftpGet(id, creds) {
  const key = sftpKey(id);
  if (sftpPool.has(key)) { return sftpPool.get(key).client; }
  const c = new SftpClient();
  await c.connect({ host:creds.host, port:parseInt(creds.port)||22, username:creds.username, password:creds.password, readyTimeout:15000 });
  sftpPool.set(key, { client:c });
  c.client.on('close', ()=>sftpPool.delete(key));
  c.client.on('error', ()=>sftpPool.delete(key));
  return c;
}
const sftpClient = id => sftpPool.get(sftpKey(id))?.client || null;
/* ═══════════════════════════════════════════════════════════════
   PLUGINS / DOWNLOADS
   - modrinth: install latest compatible jar (best-effort)
   - spigot:   via Spiget API (free resources only)
   - paper:    downloads latest Paper server jar (project build)
   - hangar:   best-effort search (API may evolve)
   ═══════════════════════════════════════════════════════════════ */


app.post('/api/sftp/:id/connect', async (req,res) => {
  let { host, port, username, password } = req.body;
  if (!host || !username || !password) return res.status(400).json({ error: 'host, username, password required' });

  host = String(host).replace(/^sftp:\/\//i, '').trim();
  port = String(port || '2022');

  // Ensure username is always email:serverUuid (uuid = :id)
  const id = String(req.params.id);
  username = String(username).trim();
  const base = username.includes(':') ? username.split(':')[0] : username;
  username = `${base}:${id}`;

  try { await sftpGet(id, { host, port, username, password }); res.json({ connected: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/sftp/:id/disconnect', async (req,res) => {
  const key=sftpKey(req.params.id);
  if (sftpPool.has(key)){await sftpPool.get(key).client.end().catch(()=>{});sftpPool.delete(key);}
  res.json({disconnected:true});
});
app.get('/api/sftp/:id/status',(req,res)=>res.json({connected:sftpPool.has(sftpKey(req.params.id))}));
app.get('/api/sftp/:id/list', async (req,res)=>{
  const dir=req.query.path||'/'; const c=sftpClient(req.params.id);
  if (!c) return res.status(400).json({error:'Not connected'});
  try {
    const items=(await c.list(dir)).filter(f=>f.name!=='.'&&f.name!=='..').map(f=>({name:f.name,type:f.type==='d'?'directory':'file',size:f.size,modified:Math.floor(f.modifyTime/1000),perms:f.rights})).sort((a,b)=>a.type!==b.type?(a.type==='directory'?-1:1):a.name.localeCompare(b.name));
    res.json({path:dir,items});
  } catch(e){sftpPool.delete(sftpKey(req.params.id));res.status(500).json({error:e.message});}
});
app.get('/api/sftp/:id/read', async (req,res)=>{
  const fp=req.query.path; if (!fp) return res.status(400).json({error:'path required'});
  const c=sftpClient(req.params.id); if (!c) return res.status(400).json({error:'Not connected'});
  try { res.json({path:fp,content:(await c.get(fp)).toString('utf8')}); } catch(e){res.status(500).json({error:e.message});}
});
app.put('/api/sftp/:id/write', async (req,res)=>{
  const {path:fp,content}=req.body; if (!fp) return res.status(400).json({error:'path required'});
  const c=sftpClient(req.params.id); if (!c) return res.status(400).json({error:'Not connected'});
  try { await c.put(Buffer.from(content||'','utf8'),fp); res.json({saved:true}); } catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/sftp/:id/upload', upload.array('files'), async (req,res)=>{
  const rp=req.body.remotePath||'/'; const c=sftpClient(req.params.id);
  if (!c) return res.status(400).json({error:'Not connected'});
  const uploaded=[];
  try { for (const f of (req.files||[])){const d=rp.replace(/\/$/,'')+'/'+f.originalname;await c.put(f.path,d);uploaded.push({name:f.originalname,dest:d});fs.unlink(f.path,()=>{});} res.json({uploaded}); }
  catch(e){for(const f of (req.files||[]))fs.unlink(f.path,()=>{});res.status(500).json({error:e.message});}
});
app.get('/api/sftp/:id/download', async (req,res)=>{
  const fp=req.query.path; if (!fp) return res.status(400).json({error:'path required'});
  const c=sftpClient(req.params.id); if (!c) return res.status(400).json({error:'Not connected'});
  try { const buf=await c.get(fp); res.setHeader('Content-Disposition',`attachment; filename="${path.basename(fp)}"`); res.setHeader('Content-Type','application/octet-stream'); res.send(buf); }
  catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/sftp/:id/delete', async (req,res)=>{
  const {path:tp,type}=req.body; if (!tp) return res.status(400).json({error:'path required'});
  const c=sftpClient(req.params.id); if (!c) return res.status(400).json({error:'Not connected'});
  try { if (type==='directory') await c.rmdir(tp,true); else await c.delete(tp); res.json({deleted:true}); }
  catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/sftp/:id/mkdir', async (req,res)=>{
  const {path:dp}=req.body; if (!dp) return res.status(400).json({error:'path required'});
  const c=sftpClient(req.params.id); if (!c) return res.status(400).json({error:'Not connected'});
  try { await c.mkdir(dp,true); res.json({created:true}); } catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/sftp/:id/rename', async (req,res)=>{
  const {oldPath,newPath}=req.body; if (!oldPath||!newPath) return res.status(400).json({error:'oldPath and newPath required'});
  const c=sftpClient(req.params.id); if (!c) return res.status(400).json({error:'Not connected'});
  try { await c.rename(oldPath,newPath); res.json({renamed:true}); } catch(e){res.status(500).json({error:e.message});}
});

/* ═══════════════════════════════════════════════════════════════
   START
   ═══════════════════════════════════════════════════════════════ */
const PORT = process.env.PORT || 3847;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[Panels] Server  → http://127.0.0.1:${PORT}`);
  console.log(`[Panels] Beacon  → ${BEACON_BASE}`);
      });
module.exports = app;


process.on('uncaughtException', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('[Panels] Backend port already in use. If you started server.js separately, close it or change PORT.');
    process.exit(0);
  }
  console.error(err);
});


/* Exaroton + Pterodactyl removed — Beacon only */
