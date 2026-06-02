// Outbound email via Resend's HTTP API. Env-gated: with no RESEND_API_KEY the
// email is recorded on the record timeline but never sent, so the CRM is fully
// usable with zero setup and "goes live" by adding the key. Never throws — a
// missing key or API error degrades to a status, mirroring lib/youtube.js.
export async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return { status: 'logged' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'Digital NIL <onboarding@resend.dev>',
        to: Array.isArray(to) ? to : [to],
        subject: subject || '(no subject)',
        html: html || ''
      })
    });
    return { status: r.ok ? 'sent' : 'failed' };
  } catch {
    return { status: 'failed' };
  }
}
