const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('ELEVENLABS_API_KEY nedostaje');
const db = new DatabaseSync(process.env.BOOKING_DB_FILE || path.join(__dirname, '..', 'appointments.db'));
const salons = db.prepare('SELECT id,agent_id,webhook_secret_id,integration_ready FROM salons').all();
const names = ['check_availability', 'book_appointment', 'cancel_appointment'];

async function get(endpoint) {
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/${endpoint}`, { headers: { 'xi-api-key': key } });
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
  return response.json();
}

(async () => {
  const listing = await get('tools?page_size=100');
  if (listing.has_more) throw new Error('Nepotpuna lista alata');
  for (const salon of salons) {
    if (!salon.integration_ready || !salon.webhook_secret_id) throw new Error(`${salon.id}: salon nije spreman`);
    const agent = await get(`agents/${salon.agent_id}`);
    const assigned = agent.conversation_config?.agent?.prompt?.tool_ids || [];
    const tools = (listing.tools || []).filter((tool) => assigned.includes(tool.id) && names.includes(tool.tool_config?.name));
    if (tools.length !== 3 || new Set(tools.map((tool) => tool.tool_config.name)).size !== 3) throw new Error(`${salon.id}: agent nema tri različita alata`);
    for (const tool of tools) {
      const headers = tool.tool_config.api_schema?.request_headers || {};
      if ((headers['X-Salon-Id'] || 'default') !== salon.id || headers['X-Agent-Secret']?.secret_id !== salon.webhook_secret_id) {
        throw new Error(`${salon.id}: alat ${tool.id} ima pogrešan salon ili tajnu`);
      }
    }
    const cancel = tools.find((tool) => tool.tool_config.name === 'cancel_appointment');
    const cancelSchema = cancel.tool_config.api_schema?.request_body_schema;
    if (cancelSchema?.required?.includes('customer_name') || cancelSchema?.properties?.customer_name ||
        ['date', 'time', 'phone'].some((field) => !cancelSchema?.required?.includes(field)) ||
        !agent.conversation_config?.agent?.prompt?.prompt?.includes('Ime mušterije NIJE uslov za otkazivanje')) {
      throw new Error(`${salon.id}: otkazivanje nije podešeno za datum, vreme i broj telefona bez imena`);
    }
    const check = tools.find((tool) => tool.tool_config.name === 'check_availability');
    const schema = check.tool_config.api_schema?.request_body_schema;
    if (!schema?.properties?.time || schema.required?.includes('barber') ||
        !agent.conversation_config?.agent?.prompt?.prompt?.includes('PRE POTVRDE obavezno pozovi check_availability PONOVO')) {
      throw new Error(`${salon.id}: rana provera vremena nije podešena`);
    }
    console.log(`${salon.id}: agent i 3 alata odgovaraju zasebnoj tajni`);
  }
  if (new Set(salons.map((salon) => salon.webhook_secret_id)).size !== salons.length) throw new Error('Dva salona dele istu tajnu');
  console.log('Sva četiri salona imaju različite tajne.');
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
