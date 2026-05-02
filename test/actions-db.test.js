const test = require('node:test');
const assert = require('node:assert');
const { dbRead } = require('../src/actions/db');

test('db.read aceita SELECT simples', async () => {
  const ctx = {
    pg: {
      query: async (sql, params) => {
        assert.match(sql, /^select\s/i);
        assert.deepStrictEqual(params, ['abc']);
        return { rows: [{ status: 'ativo' }] };
      },
    },
  };
  const r = await dbRead(ctx, {
    query: 'select status from contratos where id = $1',
    params: ['abc'],
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.rows, [{ status: 'ativo' }]);
});

test('db.read aceita SELECT com WITH (CTE)', async () => {
  const ctx = {
    pg: {
      query: async () => ({ rows: [{ count: 5 }] }),
    },
  };
  const r = await dbRead(ctx, {
    query: 'with t as (select 1 as n) select count(*) as count from t',
  });
  assert.strictEqual(r.ok, true);
});

test('db.read rejeita INSERT', async () => {
  const ctx = { pg: { query: async () => ({ rows: [] }) } };
  await assert.rejects(
    dbRead(ctx, { query: 'INSERT INTO contratos VALUES (1)' }),
    /only SELECT/i,
  );
});

test('db.read rejeita UPDATE', async () => {
  const ctx = { pg: { query: async () => ({ rows: [] }) } };
  await assert.rejects(
    dbRead(ctx, { query: 'update contratos set status=null' }),
    /only SELECT/i,
  );
});

test('db.read rejeita DELETE', async () => {
  const ctx = { pg: { query: async () => ({ rows: [] }) } };
  await assert.rejects(
    dbRead(ctx, { query: 'delete from contratos' }),
    /only SELECT/i,
  );
});

test('db.read rejeita DROP', async () => {
  const ctx = { pg: { query: async () => ({ rows: [] }) } };
  await assert.rejects(
    dbRead(ctx, { query: 'drop table contratos' }),
    /only SELECT/i,
  );
});

test('db.read fail sem ctx.pg', async () => {
  const ctx = {};
  await assert.rejects(
    dbRead(ctx, { query: 'select 1' }),
    /requires ctx\.pg/,
  );
});

test('db.read fail sem query', async () => {
  const ctx = { pg: { query: async () => ({ rows: [] }) } };
  await assert.rejects(
    dbRead(ctx, {}),
    /requires query/,
  );
});

test('db.read fail com query non-string', async () => {
  const ctx = { pg: { query: async () => ({ rows: [] }) } };
  await assert.rejects(
    dbRead(ctx, { query: 123 }),
    /requires query/,
  );
});
