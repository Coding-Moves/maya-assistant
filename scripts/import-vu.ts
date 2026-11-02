import { migrate } from '../src/db/migrate.js';
import { db } from '../src/db/client.js';
import { VuClassicTodoSource } from '../src/sources/vu/classic-todo.js';

const path = process.argv[2];
if (!path || process.argv.length !== 3) throw new Error('Usage: npm run import-vu -- /path/to/classic-todo.csv');
migrate();
try {
  const source = new VuClassicTodoSource(path);
  await source.start();
  console.log(`VU Classic To Do: ${source.counts.created} created, ${source.counts.updated} updated, ${source.counts.unchanged} unchanged.`);
} finally {
  db.close();
}
