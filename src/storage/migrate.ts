import m0001 from '../../migrations/0001_durable.sql';
import m0002 from '../../migrations/0002_bulk.sql';
import m0003 from '../../migrations/0003_preferences.sql';
import m0004 from '../../migrations/0004_people.sql';
import m0005 from '../../migrations/0005_recommendation_jobs.sql';
import m0006 from '../../migrations/0006_owner.sql';
import m0007 from '../../migrations/0007_favorites.sql';
import m0008 from '../../migrations/0008_item_ratings.sql';
import m0009 from '../../migrations/0009_dropped_shows.sql';
import m0010 from '../../migrations/0010_playback_reports.sql';
import m0011 from '../../migrations/0011_update_history.sql';

const MIGRATIONS: Array<[name: string, sql: string]> = [
  ['0001_durable.sql', m0001],
  ['0002_bulk.sql', m0002],
  ['0003_preferences.sql', m0003],
  ['0004_people.sql', m0004],
  ['0005_recommendation_jobs.sql', m0005],
  ['0006_owner.sql', m0006],
  ['0007_favorites.sql', m0007],
  ['0008_item_ratings.sql', m0008],
  ['0009_dropped_shows.sql', m0009],
  ['0010_playback_reports.sql', m0010],
  ['0011_update_history.sql', m0011],
];

const done = new WeakMap<D1Database, Promise<void>>();

export function ensureSchema(db: D1Database): Promise<void> {
  let p = done.get(db);
  if (!p) {
    p = apply(db).catch((err) => { done.delete(db); throw err; });
    done.set(db, p);
  }
  return p;
}

async function apply(db: D1Database): Promise<void> {
  await db.prepare('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)').run();
  const rows = await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>();
  const applied = new Set(rows.results.map((r) => r.name));
  for (const [name, sql] of MIGRATIONS) {
    if (applied.has(name)) continue;
    const statements = sql.split(';').map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s));
    statements.push(db.prepare('INSERT OR IGNORE INTO d1_migrations(name) VALUES(?)').bind(name));
    await db.batch(statements);
  }
}
