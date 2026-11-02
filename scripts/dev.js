/*
 * Servidor local que imita a Vercel: sirve /public como estático y enruta /api/<nombre>
 * a api/<nombre>.js con los mismos helpers (req.query, req.cookies, req.body,
 * res.status, res.json, res.send). Sin dependencias; en producción no se usa.
 */
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const API_DIR = join(ROOT, 'api');
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = 4.5 * 1024 * 1024; // mismo límite de cuerpo que Vercel Functions

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Añade los helpers de Vercel Functions (Node.js runtime). */
async function withVercelHelpers(req, res, url) {
  req.query = Object.fromEntries(url.searchParams);
  req.cookies = parseCookies(req.headers.cookie);

  const raw = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : '';
  const isJson = (req.headers['content-type'] || '').includes('application/json');
  let parsed;
  let parseError = false;
  if (raw && isJson) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parseError = true;
    }
  }
  Object.defineProperty(req, 'body', {
    get() {
      if (parseError) throw new Error('Invalid JSON');
      return isJson ? parsed : raw || undefined;
    },
  });

  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
    return res;
  };
  res.send = (data) => {
    if (typeof data === 'object' && !Buffer.isBuffer(data)) return res.json(data);
    res.end(data);
    return res;
  };
}

async function isKind(path, kind) {
  try {
    const s = await stat(path);
    return kind === 'dir' ? s.isDirectory() : s.isFile();
  } catch {
    return false;
  }
}

/** Resuelve /api/a/b como Vercel: api/a/b.js y, si no existe, un archivo dinámico api/a/[param].js. */
async function resolveApi(pathname) {
  const parts = pathname.slice('/api/'.length).replace(/\/$/, '').split('/');
  if (parts.some((p) => !/^[a-z0-9-]+$/.test(p))) return null;
  let current = API_DIR;
  const params = {};
  for (const [i, part] of parts.entries()) {
    const last = i === parts.length - 1;
    const exact = join(current, last ? `${part}.js` : part);
    if (await isKind(exact, last ? 'file' : 'dir')) {
      current = exact;
      continue;
    }
    const entries = await readdir(current).catch(() => []);
    const dynamic = entries.find((f) => (last ? /^\[\w+\]\.js$/ : /^\[\w+\]$/).test(f));
    if (!dynamic) return null;
    params[dynamic.replace(/^\[|\](\.js)?$/g, '')] = part;
    current = join(current, dynamic);
  }
  return { file: current, params };
}

async function handleApi(req, res, url) {
  const target = await resolveApi(url.pathname);
  if (!target) return notFound(res);
  await withVercelHelpers(req, res, url);
  Object.assign(req.query, target.params); // Vercel mezcla los segmentos dinámicos en req.query
  const mod = await import(pathToFileURL(target.file).href);
  await mod.default(req, res);
}

/**
 * Igual que `cleanUrls` en vercel.json: /cuenta sirve public/cuenta.html y /cuenta.html redirige (308) a /cuenta
 * conservando la búsqueda (?ref=…); /index.html va a /.
 */
async function handleStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (/\.html$/i.test(pathname)) {
    const clean = pathname.replace(/(?:index)?\.html$/i, '') || '/';
    res.writeHead(308, { Location: `${clean}${url.search}` });
    return res.end();
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  else if (!extname(pathname)) pathname += '.html';
  const file = resolve(PUBLIC_DIR, `.${pathname}`);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) return notFound(res);
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    await notFound(res, { page: true });
  }
}

/** Igual que Vercel: si existe public/404.html se sirve para rutas estáticas inexistentes. */
async function notFound(res, { page = false } = {}) {
  if (page) {
    try {
      const html = await readFile(join(PUBLIC_DIR, '404.html'));
      res.writeHead(404, { 'Content-Type': TYPES['.html'] });
      return res.end(html);
    } catch {
      /* sin 404.html: respuesta de texto */
    }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 — fuera de la zona');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const started = Date.now();
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await handleStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.writeHead(err.status || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.status === 413 ? 'Petición demasiado grande.' : 'Error del servidor local.' }));
    }
  } finally {
    if (url.pathname.startsWith('/api/')) {
      console.log(`${req.method} ${url.pathname}${url.search} → ${res.statusCode} (${Date.now() - started} ms)`);
    }
  }
});

/** Las IP de este equipo en la red local: con ellas se entra desde el celular u otro PC conectado al mismo wifi. */
const lanUrls = () => Object.values(networkInterfaces()).flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
  .map((a) => `http://${a.address}:${PORT}`);

server.listen(PORT, () => {
  console.log(`\n  DREAM ZONE · dev → http://localhost:${PORT}`);
  for (const url of lanUrls()) console.log(`  en tu red (celular u otro PC en el mismo wifi) → ${url}`);
  if (!process.env.MONGODB_URI) {
    console.warn('  ⚠ MONGODB_URI no está definida: crea .env a partir de .env.example\n');
  }
});
