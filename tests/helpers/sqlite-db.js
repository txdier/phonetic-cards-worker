import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  new URL('../../migrations/0001_create_words_table.sql', import.meta.url),
  new URL('../../migrations/0002_add_users.sql', import.meta.url),
  new URL('../../migrations/0003_article_practice.sql', import.meta.url),
  new URL('../../migrations/0004_add_last_tested.sql', import.meta.url),
  new URL('../../migrations/0005_word_learning_fsrs.sql', import.meta.url),
  new URL('../../migrations/0006_tts_cache_usage.sql', import.meta.url),
  new URL('../../migrations/0007_add_article_aloud_position.sql', import.meta.url),
  new URL('../../migrations/0008_add_article_aloud_offset.sql', import.meta.url),
  new URL('../../migrations/0009_article_translations.sql', import.meta.url)
];

export function createSqliteDb() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  for (const migration of MIGRATIONS) {
    database.exec(readFileSync(migration, 'utf8'));
  }

  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      let bindings = [];
      const runStatement = () => {
        const result = statement.run(...bindings);
        return { success: true, meta: { changes: Number(result.changes) } };
      };
      return {
        bind(...values) { bindings = values; return this; },
        async first() { return toPlainRow(statement.get(...bindings)); },
        async all() { return { results: statement.all(...bindings).map(toPlainRow) }; },
        async run() { return runStatement(); },
        async batchRun() {
          if (statement.columns().length) {
            return {
              success: true,
              results: statement.all(...bindings).map(toPlainRow),
              meta: { changes: 0 }
            };
          }
          return runStatement();
        }
      };
    },
    async batch(statements) {
      database.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) {
          results.push(await (statement.batchRun?.() || statement.run()));
        }
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    exec(sql) { database.exec(sql); },
    get(sql, ...bindings) { return toPlainRow(database.prepare(sql).get(...bindings)); },
    all(sql, ...bindings) { return database.prepare(sql).all(...bindings).map(toPlainRow); },
    close() { database.close(); }
  };
}

function toPlainRow(row) {
  return row ? { ...row } : null;
}
