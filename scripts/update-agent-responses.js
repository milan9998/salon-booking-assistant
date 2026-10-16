const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { getLiveSalons } = require('./live-salons');
const { responseSettings, checkAvailabilityDescription } = require('./agent-response-policy');

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('Nedostaje ELEVENLABS_API_KEY');

async function api(method, endpoint, body) {
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/${endpoint}`, {
    method,
    headers: { 'xi-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${method} ${endpoint}: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const verifyOnly = process.argv.includes('--verify-only');
  const salons = await getLiveSalons();
  const listing = await api('GET', 'tools?page_size=100');
  if (listing.has_more) throw new Error('Potrebna je paginacija alata');
  const targets = [];
  for (const salon of salons) {
    const agent = await api('GET', `agents/${salon.agent_id}`);
    const prompt = agent.conversation_config?.agent?.prompt;
    if (!prompt?.prompt || !Array.isArray(prompt.tool_ids)) throw new Error(`${salon.name}: nema prompta ili alata`);
    const tools = listing.tools.filter(t => prompt.tool_ids.includes(t.id) && t.tool_config?.name === 'check_availability');
    if (tools.length !== 1 || tools[0].tool_config.api_schema.request_headers['X-Salon-Id'] !== salon.id) {
      throw new Error(`${salon.name}: alat nije jedinstven i vezan za njegov salon`);
    }
    targets.push({ salon, agent, tool: tools[0], settings: responseSettings(prompt.prompt) });
  }

  if (!verifyOnly) {
    const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'salon-agent-responses-'));
    fs.writeFileSync(path.join(backup, 'before.json'), JSON.stringify(targets.map(({ salon, agent, tool }) => ({
      salon_id: salon.id, agent_id: salon.agent_id,
      prompt: agent.conversation_config.agent.prompt.prompt,
      llm: agent.conversation_config.agent.prompt.llm,
      thinking_budget: agent.conversation_config.agent.prompt.thinking_budget,
      reasoning_effort: agent.conversation_config.agent.prompt.reasoning_effort,
      enable_reasoning_summary: agent.conversation_config.agent.prompt.enable_reasoning_summary,
      tool_id: tool.id, description: tool.tool_config.description,
    })), null, 2));
    console.log(`Rezervna kopija promptova bez tajnih zaglavlja: ${backup}`);
  }

  for (const { salon, agent, tool, settings } of targets) {
    if (!verifyOnly) {
      const config = { ...tool.tool_config, description: checkAvailabilityDescription };
      await api('PATCH', `tools/${tool.id}`, { tool_config: config });
      await api('PATCH', `agents/${salon.agent_id}`, { conversation_config: { agent: { prompt: settings } } });
    }
    const after = await api('GET', `agents/${salon.agent_id}`);
    const afterTool = await api('GET', `tools/${tool.id}`);
    const afterConfig = after.conversation_config;
    for (const [field, value] of Object.entries(settings)) assert.deepEqual(afterConfig.agent.prompt[field], value, `${salon.name}: ${field}`);
    // Confirm that the narrow update preserves all unrelated settings and headers.
    const expectedConfig = structuredClone(agent.conversation_config);
    Object.assign(expectedConfig.agent.prompt, settings);
    for (const embeddedTool of expectedConfig.agent.prompt.tools || []) {
      if (embeddedTool.name === 'check_availability') embeddedTool.description = checkAvailabilityDescription;
    }
    assert.deepEqual(afterConfig, expectedConfig, `${salon.name}: promenjeno nepovezano podešavanje`);
    assert.deepEqual(afterTool.tool_config, { ...tool.tool_config, description: checkAvailabilityDescription }, `${salon.name}: promenjen ostatak alata`);
    console.log(`${salon.name}: pravila i GPT-4.1 mini potvrđeni; pozdrav, čekanje, trajanje i webhook podešavanja očuvani.`);
  }
}

main().catch(error => { console.error(error.message.split('\n')[0]); process.exitCode = 1; });
