import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createApp } from './app.mjs';

const database = resolve(process.env.DATABASE_PATH ?? 'data/estoque.sqlite');
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida.');
mkdirSync(dirname(database), { recursive: true });
const app = createApp({ database, apiKey: process.env.API_KEY });
app.server.listen(port, '127.0.0.1', () => console.log(`Estoque API: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => app.server.close(() => { app.closeStore(); process.exit(0); }));
}
