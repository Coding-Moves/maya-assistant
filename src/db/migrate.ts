import { readFileSync } from 'node:fs';
import { db } from './client.js';

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

export function migrate(): void {
  db.transaction(() => db.exec(schema))();
}
