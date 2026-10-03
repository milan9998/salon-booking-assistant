const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('ELEVENLABS_API_KEY nedostaje');
const db = new DatabaseSync(process.env.BOOKING_DB_FILE || path.join(__dirname, '..', 'appointments.db'));
const salons = db.prepare('SELECT id,webhook_secret_hash,webhook_secret_id FROM salons').all();
const expected = new Set(['check_availability', 'book_appointment', 'cancel_appointment']);

async function api(method, endpoint, body) {
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/${endpoint}`, {
    method,
    headers: { 'xi-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${method} ${endpoint}: HTTP ${response.status}`);
  return response.json();
}

(async () => {
  const listing = await api('GET', 'tools?page_size=100');
  if (listing.has_more) throw new Error('Više od 100 alata; proveri paginaciju pre izmene');
  const tools = listing.tools || [];
  const mapped = new Map(salons.map((salon) => [salon.id, []]));
  for (const tool of tools) {
    const config = tool.tool_config;
    if (!expected.has(config?.name)) continue;
    const url = config.api_schema?.url || '';
    if (!url.startsWith('https://breakfast-pharmaceuticals-decor-smithsonian.trycloudflare.com/api/')) continue;
    const salonId = config.api_schema?.request_headers?.['X-Salon-Id'] || 'default';
    if (!mapped.has(salonId)) throw new Error(`Nepoznat salon u alatu ${tool.id}`);
    mapped.get(salonId).push(tool);
  }
  for (const salon of salons) {
    const entries = mapped.get(salon.id);
    if (entries.length !== 3 || new Set(entries.map((tool) => tool.tool_config.name)).size !== 3 ||
        entries.some((tool) => !expected.has(tool.tool_config.name))) {
      throw new Error(`Nejasna mapa webhook alata za ${salon.id}; nema izmena`);
    }
  }
  console.log('Potvrđena su četiri salona i po tri odgovarajuća webhook alata.');
  for (const salon of salons) {
    if (salon.webhook_secret_hash || salon.webhook_secret_id) {
      console.log(`${salon.id}: već izolovan, preskačem`);
      continue;
    }
    const value = crypto.randomBytes(32).toString('base64url');
    const created = await api('POST', 'secrets', { type: 'new', name: `booking_${salon.id}_${Date.now()}`, value });
    if (!created.secret_id) throw new Error(`ElevenLabs nije vratio secret_id za ${salon.id}`);
    for (const tool of mapped.get(salon.id)) {
      const config = structuredClone(tool.tool_config);
      config.api_schema.request_headers['X-Agent-Secret'] = { secret_id: created.secret_id };
      const updated = await api('PATCH', `tools/${tool.id}`, { tool_config: config });
      if (updated.tool_config?.api_schema?.request_headers?.['X-Agent-Secret']?.secret_id !== created.secret_id) {
        throw new Error(`Nije potvrđena promena alata ${tool.id}`);
      }
    }
    const digest = crypto.createHash('sha256').update(value).digest('hex');
    db.prepare('UPDATE salons SET webhook_secret_hash = ?, webhook_secret_id = ? WHERE id = ?').run(digest, created.secret_id, salon.id);
    console.log(`${salon.id}: izolovan; tri alata potvrđena`);
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
