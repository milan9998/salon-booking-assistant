const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('ELEVENLABS_API_KEY nedostaje');
const db = new DatabaseSync(process.env.BOOKING_DB_FILE || path.join(__dirname, '..', 'appointments.db'));
const hasSecretColumn = db.prepare('PRAGMA table_info(salons)').all().some((column) => column.name === 'webhook_secret_id');
const salons = db.prepare(`SELECT id,agent_id,${hasSecretColumn ? 'webhook_secret_id' : 'NULL AS webhook_secret_id'} FROM salons`).all();

async function get(endpoint) {
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/${endpoint}`, { headers: { 'xi-api-key': key } });
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
  return response.json();
}

(async () => {
  const result = await get('tools?page_size=100');
  const tools = Array.isArray(result) ? result : (result.tools || []);
  console.log(JSON.stringify({
    salons: salons.map((salon) => ({ id: salon.id, agentId: salon.agent_id, isolated: Boolean(salon.webhook_secret_id) })),
    tools: tools.map((tool) => ({
      id: tool.id,
      name: tool.tool_config?.name,
      url: tool.tool_config?.api_schema?.url,
      salonId: tool.tool_config?.api_schema?.request_headers?.['X-Salon-Id'] || tool.tool_config?.api_schema?.request_headers?.['x-salon-id'],
      secretHeader: tool.tool_config?.api_schema?.request_headers?.['X-Agent-Secret'],
      bodyProperties: Object.fromEntries(Object.entries(tool.tool_config?.api_schema?.request_body_schema?.properties || {}).map(([name, value]) => [name, { type: value.type, enum: value.enum, description: value.description?.slice(0, 120) }])),
      headerTypes: Object.fromEntries(Object.entries(tool.tool_config?.api_schema?.request_headers || {}).map(([name, value]) => [name, typeof value === 'object' ? value?.type || Object.keys(value) : 'literal'])),
    })),
  }, null, 2));
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
