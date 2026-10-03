const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('ELEVENLABS_API_KEY nedostaje');
const db = new DatabaseSync(process.env.BOOKING_DB_FILE || path.join(__dirname, '..', 'appointments.db'));
const salons = db.prepare('SELECT id,agent_id FROM salons WHERE integration_ready = 1').all();

async function api(method, endpoint, body) {
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/${endpoint}`, {
    method, headers: { 'xi-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
  return response.json();
}

(async () => {
  const listing = await api('GET', 'tools?page_size=100');
  if (listing.has_more) throw new Error('Nepotpuna lista alata');
  for (const salon of salons) {
    const agent = await api('GET', `agents/${salon.agent_id}`);
    const ids = agent.conversation_config?.agent?.prompt?.tool_ids || [];
    const matches = (listing.tools || []).filter((tool) => ids.includes(tool.id) && tool.tool_config?.name === 'cancel_appointment');
    if (matches.length !== 1) throw new Error(`${salon.id}: očekivan je jedan alat za otkazivanje`);
    const tool = matches[0];
    const config = structuredClone(tool.tool_config);
    const headers = config.api_schema?.request_headers || {};
    if ((headers['X-Salon-Id'] || 'default') !== salon.id) throw new Error(`${salon.id}: pogrešan salon u alatu`);
    const schema = config.api_schema.request_body_schema;
    if (!schema?.properties || !Array.isArray(schema.required)) throw new Error(`${salon.id}: nepoznata šema alata`);
    schema.properties.customer_name = {
      type: 'string',
      description: 'Ime pod kojim je postojeći termin zakazan. Pitaj korisnika i prenesi ga tačno; ne izmišljaj ime.',
    };
    if (!schema.required.includes('customer_name')) schema.required.push('customer_name');
    const updated = await api('PATCH', `tools/${tool.id}`, { tool_config: config });
    if (!updated.tool_config?.api_schema?.request_body_schema?.required?.includes('customer_name')) {
      throw new Error(`${salon.id}: obavezno ime u alatu nije potvrđeno`);
    }
    console.log(`${salon.id}: cancel_appointment zahteva ime`);
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
