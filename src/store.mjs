import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function validateText(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new ApiError(400, 'VALIDATION', `${name} deve ter entre 1 e ${max} caracteres.`);
  }
  return value.trim();
}

export function openStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0 AND stock <= 1000000000),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS movements (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id),
      type TEXT NOT NULL CHECK(type IN ('in', 'out')),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      reason TEXT NOT NULL,
      balance_after INTEGER NOT NULL CHECK(balance_after >= 0),
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS movements_product ON movements(product_id, created_at, id);
  `);
  function product(id) {
    const value = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!value) throw new ApiError(404, 'NOT_FOUND', 'Produto não encontrado.');
    return value;
  }
  return {
    close: () => db.close(),
    product,
    products: (limit, offset) => db.prepare('SELECT * FROM products ORDER BY created_at, id LIMIT ? OFFSET ?').all(limit, offset),
    createProduct(input) {
      const sku = validateText(input.sku, 'SKU', 40).toUpperCase();
      if (!/^[A-Z0-9_-]+$/.test(sku)) throw new ApiError(400, 'VALIDATION', 'SKU aceita letras, números, _ e -.');
      const name = validateText(input.name, 'Nome', 120);
      const id = randomUUID();
      try {
        db.prepare('INSERT INTO products(id, sku, name, created_at) VALUES (?, ?, ?, ?)').run(id, sku, name, new Date().toISOString());
      } catch (error) {
        if (error.message.includes('UNIQUE constraint failed: products.sku')) throw new ApiError(409, 'SKU_EXISTS', 'SKU já cadastrado.');
        throw error;
      }
      return product(id);
    },
    movements(id, limit, offset) {
      product(id);
      return db.prepare('SELECT * FROM movements WHERE product_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?').all(id, limit, offset);
    },
    move(id, input, key) {
      key = validateText(key, 'Idempotency-Key', 100);
      const type = input.type;
      if (!['in', 'out'].includes(type)) throw new ApiError(400, 'VALIDATION', 'Tipo deve ser in ou out.');
      const quantity = input.quantity;
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000000) throw new ApiError(400, 'VALIDATION', 'Quantidade deve ser um inteiro entre 1 e 1000000000.');
      const reason = validateText(input.reason, 'Motivo', 200);
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = db.prepare('SELECT * FROM movements WHERE idempotency_key = ?').get(key);
        if (previous) {
          if (previous.product_id !== id || previous.type !== type || previous.quantity !== quantity || previous.reason !== reason) {
            throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'A chave já foi usada para outra operação.');
          }
          db.exec('COMMIT');
          return { movement: previous, replayed: true };
        }
        const current = product(id);
        const delta = type === 'in' ? quantity : -quantity;
        if (current.stock + delta < 0) throw new ApiError(409, 'INSUFFICIENT_STOCK', 'Saldo insuficiente.');
        if (current.stock + delta > 1000000000) throw new ApiError(409, 'STOCK_LIMIT', 'Limite de saldo excedido.');
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(delta, id);
        const movementId = randomUUID();
        db.prepare('INSERT INTO movements VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(movementId, id, type, quantity, reason, current.stock + delta, key, new Date().toISOString());
        const movement = db.prepare('SELECT * FROM movements WHERE id = ?').get(movementId);
        db.exec('COMMIT');
        return { movement, replayed: false };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
