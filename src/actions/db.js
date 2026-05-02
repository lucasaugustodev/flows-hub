const SELECT_ONLY = /^\s*(?:with\s+[\s\S]+?\s+as\s*\([\s\S]+?\)\s*)?select\b/i;

async function dbRead(ctx, args = {}) {
  const { query, params = [] } = args;
  if (!query || typeof query !== 'string') {
    throw new Error('db.read requires query (string)');
  }
  if (!SELECT_ONLY.test(query)) {
    throw new Error('db.read accepts only SELECT (or WITH ... SELECT)');
  }
  if (!ctx?.pg) {
    throw new Error('db.read requires ctx.pg (a pg Pool/Client)');
  }

  const result = await ctx.pg.query(query, params);
  return { ok: true, rows: result.rows };
}

module.exports = { dbRead };
