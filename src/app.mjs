import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ApiError, openStore } from './store.mjs';

const spec = readFileSync(new URL('../openapi.json', import.meta.url), 'utf8');
const maxBody = 16384;

function page(url) {
  const limit = url.searchParams.get('limit') ?? '20';
  const offset = url.searchParams.get('offset') ?? '0';
  if (!/^\d+$/.test(limit) || !/^\d+$/.test(offset) || Number(limit) < 1 || Number(limit) > 100 || !Number.isSafeInteger(Number(offset))) {
    throw new ApiError(400, 'VALIDATION', 'Use limit de 1 a 100 e offset inteiro não negativo.');
  }
  return [Number(limit), Number(offset)];
}

async function body(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new ApiError(415, 'CONTENT_TYPE', 'Envie application/json.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw new ApiError(413, 'BODY_TOO_LARGE', 'Limite de corpo: 16 KiB.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'INVALID_JSON', 'JSON inválido.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'VALIDATION', 'Envie um objeto JSON.');
  return value;
}

export function createApp({ database, apiKey }) {
  if (typeof apiKey !== 'string' || apiKey.length < 16) throw new Error('API_KEY deve ter pelo menos 16 caracteres.');
  const store = openStore(database);
  const server = createServer(async (req, res) => {
    function send(status, value) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(value));
    }
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/health') return send(200, { status: 'ok' });
      if (req.method === 'GET' && path === '/openapi.json') return send(200, JSON.parse(spec));
      const supplied = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${apiKey}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        throw new ApiError(401, 'UNAUTHORIZED', 'Bearer token inválido ou ausente.');
      }
      if (path === '/products' && req.method === 'GET') {
        const [limit, offset] = page(url);
        return send(200, { items: store.products(limit, offset), limit, offset });
      }
      if (path === '/products' && req.method === 'POST') return send(201, store.createProduct(await body(req)));
      const match = path.match(/^\/products\/([a-f0-9-]{36})(\/movements)?$/);
      if (match) {
        const [, id, movements] = match;
        if (!movements && req.method === 'GET') return send(200, store.product(id));
        if (movements && req.method === 'GET') {
          const [limit, offset] = page(url);
          return send(200, { items: store.movements(id, limit, offset), limit, offset });
        }
        if (movements && req.method === 'POST') {
          const result = store.move(id, await body(req), req.headers['idempotency-key']);
          return send(result.replayed ? 200 : 201, result);
        }
      }
      throw new ApiError(404, 'NOT_FOUND', 'Rota não encontrada.');
    } catch (error) {
      if (error instanceof ApiError) return send(error.status, { error: { code: error.code, message: error.message } });
      console.error('Erro interno:', error.code ?? error.name);
      send(500, { error: { code: 'INTERNAL', message: 'Erro interno.' } });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return { server, closeStore: () => store.close() };
}
