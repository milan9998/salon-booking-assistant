const fs = require('node:fs');
const path = require('node:path');
const { getLiveSalons } = require('./live-salons');
const { responseSettings, checkAvailabilityDescription } = require('./agent-response-policy');

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('Nedostaje ELEVENLABS_API_KEY u .env');

const toolDescriptions = {
  check_availability: checkAvailabilityDescription,
  book_appointment: 'Zakazuje provereni termin u ovom salonu tek nakon što mušterija potvrdi.',
  cancel_appointment: 'Otkazuje jedinstven potvrđen termin ovog salona na osnovu datuma, vremena i broja telefona; ime mušterije nije potrebno.',
};
const expectedToolNames = Object.keys(toolDescriptions);
const spokenServiceNames = {
  sisanje: 'šišanje',
  brada: 'sređivanje brade',
  'sisanje-i-brada': 'šišanje i brada',
  feniranje: 'feniranje',
  farbanje: 'farbanje',
};

async function api(method, endpoint, body) {
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/${endpoint}`, {
    method,
    headers: { 'xi-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`ElevenLabs ${method} ${endpoint}: HTTP ${response.status}`);
  return result;
}

function fillPrompt(template, salon) {
  const services = JSON.parse(salon.services_json);
  const barbers = JSON.parse(salon.barbers_json);
  return template.replaceAll('NAZIV_SALONA', salon.name)
    .replaceAll('IMENA_OSOBLJA', barbers.join(', '))
    .replaceAll('USLUGE_SALONA', services.map((service) => spokenServiceNames[service] || service).join(', '))
    .replaceAll('BELEŠKE_SALONA', String(salon.knowledge_notes || '').trim() || 'Nema dodatnih pravila.');
}

async function main() {
  const salons = await getLiveSalons();
  if (!salons.length) throw new Error('Baza nema salone');
  if (salons.some((salon) => !salon.agent_id || !salon.webhook_secret_id)) {
    throw new Error('Salon bez agent ID-ja ili tajne; ništa nije menjano');
  }
  const listing = await api('GET', 'tools?page_size=100');
  if (listing.has_more) throw new Error('Postoji više od 100 alata; ništa nije menjano');
  const allTools = listing.tools || [];
  const template = fs.readFileSync(path.join(__dirname, '..', 'elevenlabs-prompt-template.txt'), 'utf8');

  // Validate every target and its three salon-specific tools before writing anything.
  const targets = [];
  for (const salon of salons) {
    const agent = await api('GET', `agents/${salon.agent_id}`);
    const toolIds = agent.conversation_config?.agent?.prompt?.tool_ids || [];
    const tools = allTools.filter((tool) => toolIds.includes(tool.id));
    if (tools.length !== expectedToolNames.length || expectedToolNames.some((name) => !tools.some((tool) => tool.tool_config?.name === name))) {
      throw new Error(`Agent za ${salon.name} nema tačno tri očekivana alata; ništa nije menjano`);
    }
    for (const tool of tools) {
      const config = tool.tool_config;
      const headers = config.api_schema?.request_headers || {};
      const salonHeaderIsSafe = headers['X-Salon-Id'] === salon.id || (!headers['X-Salon-Id'] && salon.id === 'default');
      if (!salonHeaderIsSafe || headers['X-Agent-Secret']?.secret_id !== salon.webhook_secret_id) {
        throw new Error(`Alati agenta za ${salon.name} nisu vezani za njegov salon i tajnu; ništa nije menjano`);
      }
    }
    const firstMessage = agent.conversation_config?.agent?.first_message;
    if (!firstMessage) throw new Error(`Agent za ${salon.name} nema pozdravnu poruku; ništa nije menjano`);
    targets.push({ salon, agent, tools, firstMessage, prompt: fillPrompt(template, salon) });
  }

  for (const { salon, agent, tools, firstMessage, prompt } of targets) {
    const updatedToolIds = [];
    for (const tool of tools) {
      const name = tool.tool_config.name;
      const config = structuredClone(tool.tool_config);
      // The original LIBE tools relied on the backend's default-salon fallback.
      // Make that binding explicit after verifying its dedicated salon secret.
      config.api_schema.request_headers['X-Salon-Id'] = salon.id;
      config.description = toolDescriptions[name];
      const properties = config.api_schema?.request_body_schema?.properties;
      if (!properties) throw new Error(`Alat ${name} za ${salon.name} nema očekivanu JSON šemu`);
      const services = JSON.parse(salon.services_json);
      const barbers = JSON.parse(salon.barbers_json);
      if (properties.service) {
        properties.service.enum = services;
        properties.service.description = `Interna vrednost usluge: ${services.join(', ')}.`;
      }
      if (properties.barber) {
        properties.barber.enum = barbers;
        properties.barber.description = `Ime zaposlenog: ${barbers.join(', ')}.`;
      }
      if (name === 'check_availability') {
        const schema = config.api_schema?.request_body_schema;
        schema.properties.phone = {
          type: 'string',
          description: 'Opciono. Srpski mobilni broj mušterije (06..., 9 ili 10 cifara); pošalji pri završnoj proveri pre nego što zatražiš potvrdu rezervacije.',
        };
        if (Array.isArray(schema.required)) schema.required = schema.required.filter((field) => field !== 'phone');
      }
      if (name === 'cancel_appointment') {
        for (const field of ['date', 'time', 'phone']) {
          if (!properties[field]) throw new Error(`Alat za otkazivanje ${salon.name} nema polje ${field}`);
        }
        delete properties.customer_name;
        const schema = config.api_schema.request_body_schema;
        schema.required = [...new Set([...(schema.required || []).filter((field) => field !== 'customer_name'), 'date', 'time', 'phone'])];
      }
      const updated = await api('PATCH', `tools/${tool.id}`, { tool_config: config });
      if (updated.id !== tool.id) throw new Error(`Nije potvrđena izmena alata za ${salon.name}`);
      const verifiedTool = await api('GET', `tools/${tool.id}`);
      const verifiedProperties = verifiedTool.tool_config?.api_schema?.request_body_schema?.properties;
      if (properties.service && JSON.stringify(verifiedProperties?.service?.enum) !== JSON.stringify(services)) {
        throw new Error(`Usluge alata ${name} nisu ažurirane za ${salon.name}`);
      }
      if (properties.barber && JSON.stringify(verifiedProperties?.barber?.enum) !== JSON.stringify(barbers)) {
        throw new Error(`Osoblje alata ${name} nije ažurirano za ${salon.name}`);
      }
      if (name === 'cancel_appointment' && (verifiedProperties?.customer_name ||
          ['date', 'time', 'phone'].some((field) => !verifiedTool.tool_config?.api_schema?.request_body_schema?.required?.includes(field)))) {
        throw new Error(`Polja alata za otkazivanje nisu ažurirana za ${salon.name}`);
      }
      updatedToolIds.push(tool.id);
    }

    const response = await api('PATCH', `agents/${salon.agent_id}`, {
      conversation_config: { agent: { first_message: firstMessage, prompt: { ...responseSettings(prompt), tool_ids: updatedToolIds } } },
    });
    if (response.agent_id !== salon.agent_id) throw new Error(`Nije potvrđena izmena agenta za ${salon.name}`);
    const verified = await api('GET', `agents/${salon.agent_id}`);
    const finalPrompt = verified.conversation_config?.agent?.prompt?.prompt;
    const finalIds = verified.conversation_config?.agent?.prompt?.tool_ids || [];
    if (finalPrompt !== responseSettings(prompt).prompt ||
        verified.conversation_config?.agent?.prompt?.llm !== 'gpt-4.1-mini' ||
        verified.conversation_config?.agent?.prompt?.reasoning_effort !== null ||
        verified.conversation_config?.agent?.prompt?.enable_reasoning_summary !== false ||
        verified.conversation_config?.agent?.first_message !== firstMessage ||
        updatedToolIds.some((id) => !finalIds.includes(id))) {
      throw new Error(`Završna provera nije prošla za ${salon.name}`);
    }
    console.log(`Ažuriran agent: ${salon.name} (prompt i 3 alata potvrđeni)`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
