const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('ELEVENLABS_API_KEY nedostaje');
const db = new DatabaseSync(process.env.BOOKING_DB_FILE || path.join(__dirname, '..', 'appointments.db'));
const salons = db.prepare('SELECT id,agent_id FROM salons').all();

(async () => {
  for (const salon of salons) {
    const response = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${salon.agent_id}`, { headers: { 'xi-api-key': key } });
    if (!response.ok) throw new Error(`${salon.id}: HTTP ${response.status}`);
    const agent = await response.json();
    const prompt = agent.conversation_config?.agent?.prompt || {};
    const text = prompt.prompt || '';
    console.log(JSON.stringify({
      salonId: salon.id,
      agentId: salon.agent_id,
      name: agent.name,
      toolIds: prompt.tool_ids || [],
      promptKeys: Object.keys(prompt),
      builtInToolKeys: Object.keys(prompt.built_in_tools || {}),
      promptLength: text.length,
      weeklyLines: text.split('\n').filter((line) => /sedam dana|7 dana|ponovo zakaz|ponov[oae] otkaz|otkazivanj|CUSTOMER_WEEKLY/.test(line)).slice(0, 25),
      cancelLines: text.split('\n').filter((line) => /Za otkazivanje|Tada su potrebni|otkažete termin|želi da otkaže|cancel_appointment/.test(line)).slice(0, 30),
      cancelSection: salon.id === 'default' ? text.slice(Math.max(0, text.indexOf('Za otkazivanje su potrebni samo:') - 180), text.indexOf('Za otkazivanje su potrebni samo:') + 720) : undefined,
    }));
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
