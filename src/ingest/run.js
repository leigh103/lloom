import { setupDb } from '../db.js';
import { runTraining } from './train.js';
import 'dotenv/config';

setupDb();
const results = await runTraining();
for (const r of results) {
  if (r.error) console.error(`✗ ${r.service}: ${r.error}`);
  else console.log(`✓ ${r.service}: ${r.count ?? '?'} items`);
}
process.exit(0);
