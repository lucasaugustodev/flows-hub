/**
 * Email sender via Resend (https://resend.com).
 * Set RESEND_API_KEY in env. Sender defaults to onboarding@resend.dev for sandboxes;
 * configure EMAIL_FROM in .env to use your own (verified) domain.
 */
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.EMAIL_FROM || 'pageflows <noreply@somosahub.com.br>';

async function sendEmail({ to, subject, html, text }) {
  if (!RESEND_KEY) throw new Error('RESEND_API_KEY not configured on server');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
    }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`resend ${r.status}: ${body.slice(0, 300)}`);
  try { return JSON.parse(body); } catch { return { ok: true, raw: body }; }
}

function otpEmail({ to, otp, name }) {
  const subject = 'Seu código de acesso — pageflows';
  const greeting = name ? `Olá, ${name}!` : 'Olá!';
  const html = `<!doctype html>
<html><head><meta charset="utf-8"></head><body style="margin:0;padding:24px;background:#0b0b0c;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#131316;border:1px solid #27272a;border-radius:10px;padding:32px;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:24px;">
      <div style="width:10px;height:10px;background:#60a5fa;border-radius:50%"></div>
      <span style="font-weight:700;font-size:18px;">pageflows</span>
    </div>
    <p style="color:#9ca3af;font-size:14px;margin:0 0 16px;">${greeting}</p>
    <p style="font-size:14px;margin:0 0 20px;">Seu código de verificação:</p>
    <div style="text-align:center;background:#1a1a1f;padding:20px;border-radius:8px;margin:16px 0;">
      <span style="font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:32px;letter-spacing:8px;color:#60a5fa;font-weight:600;">${otp}</span>
    </div>
    <p style="color:#6b7280;font-size:12px;margin:20px 0 0;">Esse código expira em 10 minutos. Se você não solicitou um cadastro no pageflows, pode ignorar este email.</p>
  </div>
</body></html>`;
  const text = `${greeting}\n\nSeu código de verificação pageflows: ${otp}\n\nEsse código expira em 10 minutos.\n\nSe você não solicitou um cadastro, pode ignorar.`;
  return sendEmail({ to, subject, html, text });
}

module.exports = { sendEmail, otpEmail };
