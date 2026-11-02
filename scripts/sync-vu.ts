import { config } from '../src/config/env.js';
import { db } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { syncVuClassicTodo } from '../src/features/vu.js';

if (!config.VU_LMS_SYNC) throw new Error('Set VU_LMS_SYNC=true in the private .env first');

try {
  migrate();
  const counts = await syncVuClassicTodo();
  process.stdout.write(`VU Classic To Do: ${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged\n`);
} finally {
  db.close();
}
