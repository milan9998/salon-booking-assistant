const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { responseSettings, checkAvailabilityDescription } = require('./agent-response-policy');

const toolNames = ['check_availability', 'book_appointment', 'cancel_appointment'];
const maxConversationSeconds = 90;
const maxConversationMessage = 'Vreme razgovora je isteklo. Hvala, prijatno.';
const firstMessage = 'Dobar dan, kako mogu da vam pomognem?';
const spokenServiceNames = {
  sisanje: 'šišanje', brada: 'sređivanje brade', 'sisanje-i-brada': 'šišanje i brada',
  feniranje: 'feniranje', farbanje: 'farbanje',
};

async function provisionSalon(db, salon, services, barbers) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('Nedostaje ElevenLabs API ključ na serveru');
  if (!salon.agent_id) throw new Error('Salon nema agent ID');
  const api = async (method, endpoint, body) => {
    const response = await fetch(`https://api.elevenlabs.io/v1/convai/${endpoint}`, {
      method,
      headers: { 'xi-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`ElevenLabs ${endpoint}: HTTP ${response.status}`);
    return response.json();
  };

  const agent = await api('GET', `agents/${salon.agent_id}`);
  const originalIds = agent.conversation_config?.agent?.prompt?.tool_ids || [];
  const listing = await api('GET', 'tools?page_size=100');
  if (listing.has_more) throw new Error('Ima više od 100 alata; automatsko povezivanje zahteva paginaciju');
  const allTools = listing.tools || [];
  const salonTool = (tool) => tool.tool_config?.api_schema?.request_headers?.['X-Salon-Id'] === salon.id;
  const existing = allTools.filter(salonTool);
  if (existing.some((tool) => !toolNames.includes(tool.tool_config?.name))) throw new Error('Salon već ima nepoznat alat; proverite ručno');
  if (originalIds.some((id) => !existing.some((tool) => tool.id === id))) {
    throw new Error('Agent već ima druge alate. Uklonite ih ili povežite novog agenta da se saloni ne pomešaju.');
  }
  const templates = new Map(toolNames.map((name) => {
    const candidates = allTools.filter((tool) => {
      const config = tool.tool_config;
      if (config?.name !== name || config.api_schema?.request_headers?.['X-Salon-Id']) return false;
      try {
        const url = new URL(config.api_schema.url);
        return url.protocol === 'https:' && url.pathname === `/api/${name.replaceAll('_', '-')}`;
      } catch { return false; }
    });
    if (candidates.length !== 1) throw new Error(`Očekivan je tačno jedan šablon alata ${name}, nađen: ${candidates.length}`);
    return [name, candidates[0]];
  }));
  const origins = new Set([...templates.values()].map((tool) => new URL(tool.tool_config.api_schema.url).origin));
  if (origins.size !== 1) throw new Error('Šabloni ne koriste istu javnu adresu');

  let secretId = salon.webhook_secret_id;
  if (!secretId) {
    const raw = crypto.randomBytes(32).toString('base64url');
    const created = await api('POST', 'secrets', { type: 'new', name: `booking_${salon.id}_${Date.now()}`, value: raw });
    secretId = created.secret_id;
    if (!secretId) throw new Error('ElevenLabs nije vratio secret_id');
    db.prepare('UPDATE salons SET webhook_secret_hash = ?, webhook_secret_id = ? WHERE id = ?')
      .run(crypto.createHash('sha256').update(raw).digest('hex'), secretId, salon.id);
  }

  const toolIds = [];
  for (const name of toolNames) {
    let tool = existing.find((item) => item.tool_config?.name === name);
    if (!tool) {
      const config = structuredClone(templates.get(name).tool_config);
      config.api_schema.request_headers['X-Agent-Secret'] = { secret_id: secretId };
      config.api_schema.request_headers['X-Salon-Id'] = salon.id;
      tool = await api('POST', 'tools', { tool_config: config });
      if (!tool.id) throw new Error(`Nije kreiran alat ${name}`);
    }
    if (tool.tool_config.api_schema.request_headers['X-Agent-Secret']?.secret_id !== secretId) {
      throw new Error(`Alat ${name} ima drugačiju tajnu; proverite ručno`);
    }
    // Keep already-provisioned agents current too; otherwise old webhook schemas
    // cannot pass the phone needed for the weekly-limit precheck.
    const config = structuredClone(tool.tool_config);
    config.description = {
      check_availability: checkAvailabilityDescription,
      book_appointment: 'Zakazuje provereni termin u ovom salonu tek nakon što mušterija potvrdi.',
      cancel_appointment: 'Otkazuje jedinstven potvrđen termin ovog salona na osnovu datuma, vremena i broja telefona; ime mušterije nije potrebno.',
    }[name];
    const properties = config.api_schema.request_body_schema?.properties;
    if (!properties) throw new Error(`Alat ${name} nema JSON šemu tela zahteva`);
    if (properties.service) {
      properties.service.enum = services;
      properties.service.description = `Interna vrednost usluge: ${services.join(', ')}.`;
    }
    if (properties.barber) {
      properties.barber.enum = barbers;
      properties.barber.description = `Ime zaposlenog: ${barbers.join(', ')}.`;
    }
    if (name === 'check_availability') {
      properties.phone = {
        type: 'string',
        description: 'Opciono. Srpski mobilni broj mušterije (06..., 9 ili 10 cifara); pošalji pri završnoj proveri pre traženja potvrde rezervacije.',
      };
      if (Array.isArray(config.api_schema.request_body_schema.required)) {
        config.api_schema.request_body_schema.required = config.api_schema.request_body_schema.required.filter((field) => field !== 'phone');
      }
    }
    if (name === 'cancel_appointment') {
      for (const field of ['date', 'time', 'phone']) {
        if (!properties[field]) throw new Error(`Alat za otkazivanje nema polje ${field}`);
      }
      delete properties.customer_name;
      const schema = config.api_schema.request_body_schema;
      schema.required = [...new Set([...(schema.required || []).filter((field) => field !== 'customer_name'), 'date', 'time', 'phone'])];
    }
    const updatedTool = await api('PATCH', `tools/${tool.id}`, { tool_config: config });
    if (updatedTool.id !== tool.id) throw new Error(`Nije potvrđena izmena alata ${name}`);
    toolIds.push(tool.id);
  }

  const template = fs.readFileSync(path.join(__dirname, '..', 'elevenlabs-prompt-template.txt'), 'utf8');
  const knowledge = String(salon.knowledge_notes || '').trim() || 'Nema dodatnih pravila.';
  const prompt = template.replaceAll('NAZIV_SALONA', salon.name)
    .replaceAll('IMENA_OSOBLJA', barbers.join(', '))
    .replaceAll('USLUGE_SALONA', services.map((service) => spokenServiceNames[service] || service).join(', '))
    .replaceAll('BELEŠKE_SALONA', knowledge);
  await api('PATCH', `agents/${salon.agent_id}`, {
    conversation_config: {
      conversation: { max_duration_seconds: maxConversationSeconds },
      agent: { first_message: firstMessage, prompt: { ...responseSettings(prompt), tool_ids: toolIds }, max_conversation_duration_message: maxConversationMessage },
    },
  });
  const updated = await api('GET', `agents/${salon.agent_id}`);
  const updatedPrompt = updated.conversation_config?.agent?.prompt;
  if (updatedPrompt?.prompt !== responseSettings(prompt).prompt || updatedPrompt.llm !== 'gpt-4.1-mini' ||
      updatedPrompt.reasoning_effort !== null || updatedPrompt.enable_reasoning_summary !== false ||
      updated.conversation_config?.agent?.first_message !== firstMessage ||
      toolIds.some((id) => !updatedPrompt.tool_ids?.includes(id)) ||
      updated.conversation_config?.conversation?.max_duration_seconds !== maxConversationSeconds ||
      updated.conversation_config?.agent?.max_conversation_duration_message !== maxConversationMessage) {
    throw new Error('Nije potvrđeno da agent ima znanje, sva tri alata i limit trajanja');
  }
  db.prepare('UPDATE salons SET integration_ready = 1 WHERE id = ?').run(salon.id);
  return { salon_id: salon.id, agent_id: salon.agent_id, tools: toolNames };
}

module.exports = { provisionSalon };
