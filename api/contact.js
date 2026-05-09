// Vercel Serverless Function — handles contact form submissions
// Stores in Airtable + sends Telegram notification
// Env vars (lowercase, matching what's in Vercel):
//   airtablepat, airtablebaseid, airtablename, telegrambottoken, telegramchatid

export default async function handler(req, res) {
  // CORS / method guard
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Vercel auto-parses JSON bodies for Content-Type: application/json
  const body = req.body || {};
  const name = (body.name || '').toString().trim();
  const email = (body.email || '').toString().trim().toLowerCase();
  const role = (body.role || '').toString().trim();
  const workshop = (body.workshop || '').toString().trim();
  const company = (body.company || '').toString().trim();
  const message = (body.message || '').toString().trim();

  // Basic validation
  if (!name || !email || !role || !message) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Invalid email' });
  }
  if (name.length > 200 || message.length > 5000) {
    return res.status(400).json({ ok: false, error: 'Field too long' });
  }
  if (!['participant', 'maker', 'shop'].includes(role)) {
    return res.status(400).json({ ok: false, error: 'Invalid role' });
  }

  // Read env vars
  const PAT = process.env.airtablepat;
  const BASE = process.env.airtablebaseid;
  const TABLE = process.env.airtablename;
  const TG_TOKEN = process.env.telegrambottoken;
  const TG_CHAT = process.env.telegramchatid;

  if (!PAT || !BASE || !TABLE) {
    console.error('[contact] Missing Airtable env vars', { hasPat: !!PAT, hasBase: !!BASE, hasTable: !!TABLE });
    return res.status(500).json({ ok: false, error: 'Server misconfigured (Airtable)' });
  }

  // 1) Create row in Airtable (the source of truth)
  let airtableRecordId = null;
  let airtableOk = false;
  try {
    const airtableUrl = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(TABLE)}`;
    const atRes = await fetch(airtableUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PAT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          'Name': name,
          'Email': email,
          'Role': role,
          'Workshop': workshop,
          'Company': company,
          'Message': message,
          'Submitted At': new Date().toISOString(),
          'Status': 'New',
        },
        typecast: true, // lets Airtable auto-create select options if needed
      }),
    });
    if (atRes.ok) {
      const data = await atRes.json();
      airtableRecordId = data.id;
      airtableOk = true;
    } else {
      const errText = await atRes.text();
      console.error('[contact] Airtable error', atRes.status, errText);
    }
  } catch (err) {
    console.error('[contact] Airtable exception', err && err.message);
  }

  if (!airtableOk) {
    // Airtable is the primary store — if it fails, we fail the request
    return res.status(502).json({ ok: false, error: 'Could not save submission' });
  }

  // 2) Send Telegram notification (best-effort, don't fail the request if it errors)
  if (TG_TOKEN && TG_CHAT) {
    try {
      const lines = [
        '<b>🆕 New form submission</b>',
        '',
        `👤 <b>${escapeHtml(name)}</b>`,
        `📧 ${escapeHtml(email)}`,
        `🎭 Role: <b>${escapeHtml(role)}</b>`,
      ];
      if (workshop) lines.push(`🎨 Workshop: ${escapeHtml(workshop)}`);
      if (company) lines.push(`🏪 ${role === 'shop' ? 'Shop' : 'Company/Portfolio'}: ${escapeHtml(company)}`);
      lines.push('', `💬 ${escapeHtml(message.slice(0, 800))}`);
      if (airtableRecordId) {
        lines.push('', `<a href="https://airtable.com/${BASE}/${airtableRecordId}">📊 View in Airtable</a>`);
      }
      const text = lines.join('\n');

      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TG_CHAT,
          text: text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
    } catch (err) {
      console.error('[contact] Telegram exception', err && err.message);
    }
  }

  return res.status(200).json({ ok: true, id: airtableRecordId });
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
