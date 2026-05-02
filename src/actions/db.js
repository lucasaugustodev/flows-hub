const SELECT_ONLY = /^\s*(?:with\s+[\s\S]+?\s+as\s*\([\s\S]+?\)\s*)?select\b/i;
const STATEMENT_STACKING = /;\s*\S/; // qualquer `;` seguido de não-whitespace = statement extra

async function dbRead(ctx, args = {}) {
  const { query, params = [] } = args;
  if (!query || typeof query !== 'string') {
    throw new Error('db.read requires query (string)');
  }
  if (!SELECT_ONLY.test(query)) {
    throw new Error('db.read accepts only SELECT (or WITH ... SELECT)');
  }
  // Bloqueia statement stacking (SELECT 1; DROP TABLE t)
  // Permite trailing semicolon (SELECT 1;)
  const trimmed = query.replace(/;\s*$/, '');
  if (STATEMENT_STACKING.test(trimmed)) {
    throw new Error('db.read rejects multi-statement queries (statement stacking blocked)');
  }
  // Bloqueia DML em CTEs (WITH foo AS (DELETE FROM t) SELECT...)
  // Aggressive guard: também rejeita queries onde a palavra aparece como literal.
  // Usuários devem usar params em vez de strings literais com palavras DML no texto.
  const DML_IN_CTE = /\b(insert|update|delete|merge|drop|alter|truncate|create|grant|revoke)\b/i;
  if (DML_IN_CTE.test(query)) {
    throw new Error(
      "db.read rejects DML keywords anywhere in query (insert/update/delete/etc). " +
      "Quote literal strings via params: WHERE status = $1 instead of WHERE status = 'deleted'.",
    );
  }
  if (params && !Array.isArray(params)) {
    throw new Error('db.read params must be an array');
  }
  if (!ctx?.pg) {
    throw new Error('db.read requires ctx.pg (a pg Pool/Client)');
  }

  const result = await ctx.pg.query(query, params);
  return { ok: true, rows: result.rows };
}

module.exports = { dbRead };
