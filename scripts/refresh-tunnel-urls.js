const { getLiveSalons } = require('./live-salons');

const base = process.argv[2];
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('ELEVENLABS_API_KEY nedostaje');
if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(base || '')) throw new Error('Navedi proverenu HTTPS trycloudflare adresu bez završne kose crte');
const names = new Set(['check_availability', 'book_appointment', 'cancel_appointment']);

async function api(method, endpoint, body) {
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/${endpoint}`, {
    method, headers: { 'xi-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${method} ${endpoint}: HTTP ${response.status}`);
  return response.json();
}

(async () => {
  const salons = (await getLiveSalons()).filter(salon => salon.integration_ready);
  const check = await fetch(`${base}/`);
  if (!check.ok) throw new Error(`Novi tunel nije dostupan: HTTP ${check.status}`);
  if (!salons.length) throw new Error('Nema povezanih salona u PostgreSQL aplikaciji');
  const listing = await api('GET', 'tools?page_size=100');
  if (listing.has_more) throw new Error('Lista alata nije potpuna');
  const updates = [];
  for (const salon of salons) {
    const agent = await api('GET', `agents/${salon.agent_id}`);
    const ids = agent.conversation_config?.agent?.prompt?.tool_ids || [];
    const tools = listing.tools.filter((tool) => ids.includes(tool.id) && names.has(tool.tool_config?.name));
    if (tools.length !== 3 || new Set(tools.map((tool) => tool.tool_config.name)).size !== 3) throw new Error(`${salon.id}: nisu nađena tačno tri booking alata`);
    for (const tool of tools) {
      const config = tool.tool_config;
      const headers = config.api_schema?.request_headers || {};
      const url = new URL(config.api_schema?.url || 'https://invalid.local/');
      if ((headers['X-Salon-Id'] || 'default') !== salon.id || headers['X-Agent-Secret']?.secret_id !== salon.webhook_secret_id ||
          !url.hostname.endsWith('.trycloudflare.com') || url.pathname !== `/api/${config.name.replaceAll('_', '-')}`) {
        throw new Error(`${salon.id}: alat ${tool.id} nema očekivani salon, tajnu ili putanju`);
      }
      updates.push({ salon, tool, url });
    }
  }
  for (const { salon, tool, url } of updates) {
    const config = structuredClone(tool.tool_config);
    config.api_schema.url = `${base}${url.pathname}`;
    if (config.api_schema.url !== tool.tool_config.api_schema.url) await api('PATCH', `tools/${tool.id}`, { tool_config: config });
    const verified = await api('GET', `tools/${tool.id}`);
    if (verified.tool_config?.api_schema?.url !== config.api_schema.url ||
        verified.tool_config?.api_schema?.request_headers?.['X-Agent-Secret']?.secret_id !== salon.webhook_secret_id) {
      throw new Error(`${salon.id}: novi URL ili tajna nisu potvrđeni za ${tool.id}`);
    }
    console.log(`${salon.id}: ${tool.tool_config.name} → URL potvrđen`);
  }
  console.log(`Potvrđeno ${updates.length} webhook alata.`);
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
