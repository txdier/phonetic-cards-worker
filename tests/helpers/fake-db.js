export function createFakeDb(queues = {}) {
  const calls = [];
  const batches = [];
  const take = (name, fallback) => queues[name]?.shift() ?? fallback;
  return {
    calls,
    batches,
    prepare(sql) {
      const call = { sql: sql.replace(/\s+/g, ' ').trim(), bindings: [] };
      calls.push(call);
      return {
        bind(...bindings) { call.bindings = bindings; return this; },
        first: async () => take('first', null),
        all: async () => take('all', { results: [] }),
        run: async () => take('run', { success: true, meta: { changes: 1 } })
      };
    },
    async batch(statements) {
      batches.push(statements);
      return Promise.all(statements.map(statement => statement.run()));
    }
  };
}
