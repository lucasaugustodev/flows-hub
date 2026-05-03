const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { RESOLVERS } = require('../src/resolvers');

let server;
let port;

test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/auth/v1/token?grant_type=password' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { email, password } = JSON.parse(body);
        if (email === 'good@x.com' && password === 'pass') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            access_token: 'fake.jwt.token',
            user: { id: 'u-1', email },
          }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_credentials', error_description: 'Invalid login credentials' }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
});

test.after(() => server.close());

test('supabase.login retorna access_token em sucesso', async () => {
  const token = await RESOLVERS['supabase.login']({
    email: 'good@x.com',
    password: 'pass',
  }, {
    SUPABASE_URL: `http://localhost:${port}`,
    SUPABASE_ANON_KEY: 'anon-key',
  });
  assert.strictEqual(token, 'fake.jwt.token');
});

test('supabase.login aceita vars dentro do contexto do replay', async () => {
  const token = await RESOLVERS['supabase.login']({
    email: 'good@x.com',
    password: 'pass',
  }, {
    vars: {
      SUPABASE_URL: `http://localhost:${port}`,
      SUPABASE_ANON_KEY: 'anon-key',
    },
  });
  assert.strictEqual(token, 'fake.jwt.token');
});

test('jwt.sign_admin aceita ADMIN_USER_ID dentro do contexto do replay', async () => {
  const token = await RESOLVERS['jwt.sign_admin']({}, {
    vars: {
      ADMIN_USER_ID: 'admin-user-id',
      SUPABASE_JWT_SECRET: 'test-secret',
    },
  });

  assert.match(token, /^[^.]+\.[^.]+\.[^.]+$/);
});

test('supabase.login throw em credenciais inválidas (400)', async () => {
  await assert.rejects(
    RESOLVERS['supabase.login']({
      email: 'wrong@x.com',
      password: 'wrong',
    }, {
      SUPABASE_URL: `http://localhost:${port}`,
      SUPABASE_ANON_KEY: 'anon-key',
    }),
    /supabase.login failed \(400\)/,
  );
});

test('supabase.login throw sem email', async () => {
  await assert.rejects(
    RESOLVERS['supabase.login']({ password: 'p' }, { SUPABASE_URL: 'x', SUPABASE_ANON_KEY: 'y' }),
    /requires email \+ password/,
  );
});

test('supabase.login throw sem password', async () => {
  await assert.rejects(
    RESOLVERS['supabase.login']({ email: 'a@b.com' }, { SUPABASE_URL: 'x', SUPABASE_ANON_KEY: 'y' }),
    /requires email \+ password/,
  );
});

test('supabase.login throw sem SUPABASE_URL', async () => {
  const oldUrl = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  try {
    await assert.rejects(
      RESOLVERS['supabase.login']({ email: 'a@b.com', password: 'p' }, { SUPABASE_ANON_KEY: 'x' }),
      /missing SUPABASE_URL/,
    );
  } finally {
    if (oldUrl) process.env.SUPABASE_URL = oldUrl;
  }
});

test('supabase.login throw sem access_token na response', async () => {
  // server retorna 200 mas sem access_token (caso bizarro)
  const weirdServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ user: { id: 'u' } })); // sem access_token
  });
  await new Promise((r) => weirdServer.listen(0, r));
  const wp = weirdServer.address().port;
  try {
    await assert.rejects(
      RESOLVERS['supabase.login']({
        email: 'a@b.com', password: 'p',
      }, {
        SUPABASE_URL: `http://localhost:${wp}`,
        SUPABASE_ANON_KEY: 'anon',
      }),
      /no access_token/,
    );
  } finally {
    weirdServer.close();
  }
});
