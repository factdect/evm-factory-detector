// Undo update-13's evidence migration so an older build can open the database again.
// Stop the service first (Railway: remove the deployment or scale to zero), then in a shell that
// mounts the volume:   DB_PATH=/data/factory.db node scripts/rollback-evidence.mjs [--force]
import { rollbackEvidence } from '../src/db.js';

const file = process.env.DB_PATH || './data/factory.db';
const r = rollbackEvidence(file, { force: process.argv.includes('--force') });
if (r.done) console.info(`rolled back: ${r.rows} evidence rows are in the text table again (${file}). An older build can open it now.`);
else { console.error(`not rolled back: ${r.reason}`); process.exitCode = 1; }
