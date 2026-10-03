const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('ELEVENLABS_API_KEY nedostaje');
const db = new DatabaseSync(process.env.BOOKING_DB_FILE || path.join(__dirname, '..', 'appointments.db'));
const salons = db.prepare('SELECT id,agent_id FROM salons WHERE integration_ready = 1').all();

async function get(endpoint) {
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/${endpoint}`, { headers: { 'xi-api-key': key } });
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
  return response.json();
}

(async () => {
  const listing = await get('tools?page_size=100');
  for (const salon of salons) {
    const agent = await get(`agents/${salon.agent_id}`);
    const prompt = agent.conversation_config?.agent?.prompt;
    const tool = listing.tools.find((item) => prompt.tool_ids.includes(item.id) && item.tool_config?.name === 'check_availability');
    if (!tool) throw new Error(`${salon.id}: check_availability nije nađen`);
    console.log(JSON.stringify({
      salon: salon.id,
      toolId: tool.id,
      schema: tool.tool_config.api_schema.request_body_schema,
      promptLines: prompt.prompt.split('\n').filter((line) => /check_availability|slobod|radno vreme|zauzet|uslugu|datum|frizer|osoblje/.test(line)).slice(0, 35),
      defaultCheckSection: salon.id === 'default' ? prompt.prompt.slice(prompt.prompt.indexOf('Čim su poznati usluga'), prompt.prompt.indexOf('Čim su poznati usluga') + 1300) : undefined,
    }, null, 2));
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
