import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/app.mjs';

const key = 'integration-only-token-12345';
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'estoque-test-'));
  const database = join(dir, 'test.sqlite');
  let app;
  let base;
  async function start() {
    app = createApp({ database, apiKey: key });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function stop() {
    await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()));
    app.closeStore();
  }
  await start();
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true }); });
  async function request(path, { method = 'GET', data, headers = {}, raw } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(data !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: raw ?? (data !== undefined ? JSON.stringify(data) : undefined),
    });
    return { status: response.status, body: await response.json() };
  }
  async function product(sku = 'BOX-001') {
    const response = await request('/products', { method: 'POST', data: { sku, name: 'Caixa retornável' } });
    assert.equal(response.status, 201);
    return response.body;
  }
  const move = (id, quantity = 5, type = 'in', idempotency = 'move-1', reason = 'Recebimento') => request(`/products/${id}/movements`, { method: 'POST', headers: { 'idempotency-key': idempotency }, data: { quantity, type, reason } });
  return { request, product, move, restart: async () => { await stop(); await start(); } };
}

test('saúde e contrato OpenAPI são públicos', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/health', { headers: { authorization: '' } })).status, 200);
  const contract = await request('/openapi.json', { headers: { authorization: '' } });
  assert.equal(contract.body.openapi, '3.1.0');
  assert.ok(contract.body.paths['/products/{id}/movements'].post);
});
test('dados exigem token válido', async t => {
  const { request } = await fixture(t);
  for (const authorization of ['', 'Bearer invalid']) assert.equal((await request('/products', { headers: { authorization } })).status, 401);
});
test('produto novo normaliza SKU e começa sem saldo', async t => {
  const { product, request } = await fixture(t);
  const created = await product(' box-001 ');
  assert.equal(created.sku, 'BOX-001');
  assert.equal(created.stock, 0);
  assert.equal((await request(`/products/${created.id}`)).body.name, 'Caixa retornável');
});
test('SKU duplicado não cria outro produto', async t => {
  const { product, request } = await fixture(t);
  await product();
  assert.equal((await request('/products', { method: 'POST', data: { sku: 'box-001', name: 'Outro' } })).status, 409);
  assert.equal((await request('/products')).body.items.length, 1);
});
test('cadastro rejeita nomes vazios e SKU inválido', async t => {
  const { request } = await fixture(t);
  for (const data of [{ sku: 'a', name: '' }, { sku: 'x x', name: 'Caixa' }, { name: 'Caixa' }, { sku: 'a', name: 'a'.repeat(121) }]) {
    assert.equal((await request('/products', { method: 'POST', data })).status, 400);
  }
});
test('entrada grava saldo e movimento relacionados', async t => {
  const { product, move, request } = await fixture(t);
  const p = await product();
  const result = await move(p.id);
  assert.equal(result.status, 201);
  assert.equal(result.body.movement.balance_after, 5);
  assert.equal((await request(`/products/${p.id}`)).body.stock, 5);
  assert.equal((await request(`/products/${p.id}/movements`)).body.items[0].product_id, p.id);
});
test('saída pode consumir exatamente o saldo', async t => {
  const { product, move, request } = await fixture(t);
  const p = await product(); await move(p.id);
  assert.equal((await move(p.id, 5, 'out', 'exit-1')).status, 201);
  assert.equal((await request(`/products/${p.id}`)).body.stock, 0);
});
test('saída sem saldo faz rollback sem histórico parcial', async t => {
  const { product, move, request } = await fixture(t);
  const p = await product();
  assert.equal((await move(p.id, 1, 'out')).body.error.code, 'INSUFFICIENT_STOCK');
  assert.equal((await request(`/products/${p.id}`)).body.stock, 0);
  assert.equal((await request(`/products/${p.id}/movements`)).body.items.length, 0);
  assert.equal((await move(p.id)).status, 201);
});
test('repetir chave e conteúdo não duplica a entrada', async t => {
  const { product, move, request } = await fixture(t);
  const p = await product(); const first = await move(p.id); const retry = await move(p.id);
  assert.equal(retry.status, 200); assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.movement.id, first.body.movement.id);
  assert.equal((await request(`/products/${p.id}`)).body.stock, 5);
});
test('chave repetida com outro conteúdo é conflito', async t => {
  const { product, move, request } = await fixture(t);
  const p = await product(); await move(p.id);
  assert.equal((await move(p.id, 6)).body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await request(`/products/${p.id}`)).body.stock, 5);
});
test('chave não pode ser reutilizada para outro produto', async t => {
  const { product, move } = await fixture(t);
  const p = await product(); const other = await product('BOX-002'); await move(p.id);
  assert.equal((await move(other.id)).status, 409);
});
test('quantidade deve ser inteiro positivo dentro do limite', async t => {
  const { product, move } = await fixture(t); const p = await product();
  for (const quantity of [0, -1, 1.5, '5', 1000000001]) assert.equal((await move(p.id, quantity)).status, 400);
});
test('tipo, motivo e chave são obrigatórios', async t => {
  const { product, move, request } = await fixture(t); const p = await product();
  assert.equal((await move(p.id, 1, 'other')).status, 400);
  assert.equal((await move(p.id, 1, 'in', 'key', '')).status, 400);
  assert.equal((await request(`/products/${p.id}/movements`, { method: 'POST', data: { type: 'in', quantity: 1, reason: 'Teste' } })).status, 400);
});
test('JSON malformado, array e tipo incorreto são rejeitados', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/products', { method: 'POST', raw: '{' })).body.error.code, 'INVALID_JSON');
  assert.equal((await request('/products', { method: 'POST', data: [] })).status, 400);
  assert.equal((await request('/products', { method: 'POST', raw: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
});
test('corpo maior que 16 KiB é rejeitado', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/products', { method: 'POST', data: { name: 'x'.repeat(17000) } })).status, 413);
});
test('produto inexistente não aceita movimento', async t => {
  const { move } = await fixture(t);
  assert.equal((await move('00000000-0000-0000-0000-000000000000')).status, 404);
});
test('paginação separa produtos e rejeita parâmetros inválidos', async t => {
  const { product, request } = await fixture(t);
  await product(); await product('BOX-002');
  const first = await request('/products?limit=1'); const second = await request('/products?limit=1&offset=1');
  assert.equal(first.body.items.length, 1); assert.notEqual(first.body.items[0].id, second.body.items[0].id);
  for (const query of ['limit=0', 'limit=101', 'offset=-1', 'limit=abc']) assert.equal((await request('/products?' + query)).status, 400);
});
test('requisições concorrentes não deixam saldo negativo', async t => {
  const { product, move, request } = await fixture(t); const p = await product(); await move(p.id, 5);
  const results = await Promise.all([move(p.id, 4, 'out', 'out-a'), move(p.id, 4, 'out', 'out-b')]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal((await request(`/products/${p.id}`)).body.stock, 1);
  assert.equal((await request(`/products/${p.id}/movements`)).body.items.length, 2);
});
test('saldo tem limite superior e falha sem movimento parcial', async t => {
  const { product, move, request } = await fixture(t); const p = await product(); await move(p.id, 1000000000);
  assert.equal((await move(p.id, 1, 'in', 'over')).body.error.code, 'STOCK_LIMIT');
  assert.equal((await request(`/products/${p.id}/movements`)).body.items.length, 1);
});
test('reiniciar servidor preserva saldo, histórico e idempotência', async t => {
  const { product, move, restart, request } = await fixture(t); const p = await product(); await move(p.id);
  await restart();
  assert.equal((await request(`/products/${p.id}`)).body.stock, 5);
  assert.equal((await move(p.id)).body.replayed, true);
  assert.equal((await request(`/products/${p.id}/movements`)).body.items.length, 1);
});
test('rota desconhecida retorna erro estruturado', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/unknown')).body.error.code, 'NOT_FOUND');
});
