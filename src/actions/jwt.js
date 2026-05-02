const { SignJWT } = require('jose');

async function jwtSign(ctx, args = {}) {
  const { sub, role = 'authenticated', aud = 'authenticated', expires_in = 3600 } = args;
  if (!sub) throw new Error('jwt.sign requires sub');

  const secret = ctx?.env?.JWT_SECRET || process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error('jwt.sign requires JWT_SECRET in ctx.env or SUPABASE_JWT_SECRET in process.env');
  }

  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub)
    .setAudience(aud)
    .setIssuedAt(now)
    .setExpirationTime(now + expires_in)
    .sign(new TextEncoder().encode(secret));

  if (ctx && args.store_as && ctx.vars) {
    ctx.vars[args.store_as] = token;
  }
  return { ok: true, token };
}

module.exports = { jwtSign };
