import ContactLog from '../models/ContactLog.js';
import { sendEmail } from './resend.js';

// Compliance oversight = email to the coach's complianceOfficerEmail. Two surfaces:
//   1. Immediate alert when a coach attempts an action the calendar prohibits.
//   2. On-demand digest of a coach's recent contact log (admin/coach triggered).
// Both degrade to a no-op "logged" status when Resend isn't configured (see
// lib/resend.js), so the feature is safe with zero setup.

const esc = (s) => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

export async function sendViolationAlert({ coach, recruit, action, verdict }) {
  const to = coach?.complianceOfficerEmail;
  if (!to) return { status: 'logged' };
  const when = verdict?.nextAllowedAt ? new Date(verdict.nextAllowedAt).toISOString().slice(0, 10) : 'a permitted period';
  return sendEmail({
    to,
    subject: `[Compliance] Blocked recruiting action by ${coach.name}`,
    html: `<div style="font-family:system-ui,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
      <h2 style="margin:0 0 8px">Recruiting action blocked</h2>
      <p style="color:#555;font-size:14px;line-height:1.6">
        Coach <strong>${esc(coach.name)}</strong> (${esc(coach.program || 'program')}) attempted to
        <strong>${esc(action)}</strong> recruit <strong>${esc(recruit?.name)}</strong> during
        <strong>${esc(verdict?.periodLabel || verdict?.periodType)}</strong>. The platform blocked it.
      </p>
      <p style="color:#555;font-size:14px;line-height:1.6">${esc(verdict?.reason || '')}</p>
      <p style="color:#999;font-size:12px">Action becomes permissible from ${esc(when)}. This is an automated compliance notice.</p>
    </div>`
  });
}

// A digest of the most recent log entries for a coach (default 30). Returns the
// rows alongside the send status so the caller can show them in-app too.
export async function sendContactDigest({ coach, limit = 30 }) {
  const rows = await ContactLog.find({ coach: coach._id })
    .populate('recruit', 'name')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  const to = coach?.complianceOfficerEmail;
  if (!to) return { status: 'logged', rows };

  const list = rows.map(r => `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ')}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(r.recruit?.name || '—')}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(r.kind)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(r.periodType)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${r.allowed ? 'allowed' : 'BLOCKED'}</td>
    </tr>`).join('');

  const { status } = await sendEmail({
    to,
    subject: `[Compliance] Contact log digest — ${coach.name} (${rows.length} entries)`,
    html: `<div style="font-family:system-ui,Arial,sans-serif;max-width:680px;margin:0 auto;padding:24px">
      <h2 style="margin:0 0 8px">Recruiting contact log</h2>
      <p style="color:#555;font-size:13px">${esc(coach.name)} — ${esc(coach.program || '')}. Most recent ${rows.length} interactions.</p>
      <table style="border-collapse:collapse;width:100%;font-size:12px;color:#333">
        <thead><tr style="text-align:left;color:#888">
          <th style="padding:6px 10px">When</th><th style="padding:6px 10px">Recruit</th>
          <th style="padding:6px 10px">Kind</th><th style="padding:6px 10px">Period</th><th style="padding:6px 10px">Status</th>
        </tr></thead><tbody>${list}</tbody>
      </table>
    </div>`
  });
  return { status, rows };
}
