const test = require('node:test');
const assert = require('node:assert');
const { jwtSign } = require('../src/actions/jwt');
const { jwtVerify } = require('jose');

const SECRET = 'test-secret-' + 'x'.repeat(40);

test('jwt.sign cria HS256 verificável', async () => {
  const ctx = { vars: { SUPABASE_JWT_SECRET: SECRET } };
  const r = await jwtSign(ctx, {
    sub: '00000000-0000-0000-0000-000000000001',
    role: 'authenticated',
    aud: 'authenticated',
    expires_in: 60,
  });
  assert.strictEqual(r.ok, true);
  assert.match(r.token, /^eyJ/);

  const { payload } = await jwtVerify(
    r.token,
    new TextEncoder().encode(SECRET),
    { audience: 'authenticated', algorithms: ['HS256'] },
  );
  assert.strictEqual(payload.sub, '00000000-0000-0000-0000-000000000001');
  assert.strictEqual(payload.role, 'authenticated');
});

test('jwt.sign throw sem sub', async () => {
  const ctx = { vars: { SUPABASE_JWT_SECRET: SECRET } };
  await assert.rejects(jwtSign(ctx, {}), /requires sub/);
});

test('jwt.sign throw sem JWT_SECRET', async () => {
  const ctx = { vars: {} };
  delete process.env.SUPABASE_JWT_SECRET;
  await assert.rejects(jwtSign(ctx, { sub: 'u1' }), /SUPABASE_JWT_SECRET/);
});

test('jwt.sign respeita store_as gravando em ctx.vars', async () => {
  const ctx = { vars: { SUPABASE_JWT_SECRET: SECRET } };
  await jwtSign(ctx, { sub: 'u1', store_as: 'MY_TOKEN' });
  assert.ok(ctx.vars.MY_TOKEN);
  assert.match(ctx.vars.MY_TOKEN, /^eyJ/);
  // SUPABASE_JWT_SECRET still present in vars
  assert.strictEqual(ctx.vars.SUPABASE_JWT_SECRET, SECRET);
});

test('jwt.sign default expires_in 3600s', async () => {
  const ctx = { vars: { SUPABASE_JWT_SECRET: SECRET } };
  const r = await jwtSign(ctx, { sub: 'u1' });
  const { payload } = await jwtVerify(
    r.token,
    new TextEncoder().encode(SECRET),
    { audience: 'authenticated', algorithms: ['HS256'] },
  );
  // exp deve ser ~now + 3600
  const now = Math.floor(Date.now() / 1000);
  const delta = payload.exp - now;
  assert.ok(delta >= 3590 && delta <= 3600, `exp delta should be ~3600, got ${delta}`);
});

test('jwt.sign lê SUPABASE_JWT_SECRET de ctx.vars (project vars)', async () => {
  const oldEnv = process.env.SUPABASE_JWT_SECRET;
  delete process.env.SUPABASE_JWT_SECRET;
  try {
    const ctx = { vars: { SUPABASE_JWT_SECRET: SECRET } };
    const r = await jwtSign(ctx, { sub: 'u-from-vars' });
    assert.strictEqual(r.ok, true);
    const { payload } = await jwtVerify(
      r.token, new TextEncoder().encode(SECRET),
      { audience: 'authenticated', algorithms: ['HS256'] },
    );
    assert.strictEqual(payload.sub, 'u-from-vars');
  } finally {
    if (oldEnv) process.env.SUPABASE_JWT_SECRET = oldEnv;
  }
});
