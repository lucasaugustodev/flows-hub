/**
 * mailtm actions — runtime, mid-flow.
 * Pareia com o resolver `mailtm.new` (que cria a inbox no início e bind ao ctx).
 */

async function waitOtp(ctx, args = {}) {
  const bind = args.bind || 'default';
  const inst = (ctx?.mailtmInstances || {})[bind];
  if (!inst) {
    throw new Error(
      `mailtm.wait_otp: nenhuma inbox bound como "${bind}". Adicione { name: ..., resolver: "mailtm.new", args: { bind: "${bind}" } } no vars.`,
    );
  }
  const timeoutMs = (args.timeout_seconds || 120) * 1000;
  const out = await inst.waitForOTP({
    timeout: timeoutMs,
    subjectFilter: args.subject || null,
    fromFilter: args.from || null,
    otpPattern: args.regex ? new RegExp(args.regex) : null,
    minLength: args.min || 4,
    maxLength: args.max || 8,
  });
  return {
    ok: true,
    body: JSON.stringify(out),
    otp: out.otp,
    subject: out.subject,
    from: out.from,
    extracted: { OTP: out.otp },
  };
}

module.exports = { waitOtp };
