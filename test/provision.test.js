const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { provisionSalon } = require('../scripts/provision-salon');

test('novi salon dobija samo svoja tri alata i prompt iz svog znanja', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE salons (id TEXT PRIMARY KEY, webhook_secret_hash TEXT, webhook_secret_id TEXT, integration_ready INTEGER NOT NULL DEFAULT 0)');
  db.prepare('INSERT INTO salons (id) VALUES (?)').run('novi-salon');
  const names = ['check_availability', 'book_appointment', 'cancel_appointment'];
  const tools = names.map((name, index) => ({
    id: `template_${index}`,
    tool_config: {
      type: 'webhook', name, description: 'Stari salon',
      api_schema: {
        url: `https://demo.trycloudflare.com/api/${name.replaceAll('_', '-')}`,
        method: 'POST', request_headers: { 'X-Agent-Secret': { secret_id: 'old' } },
        request_body_schema: { type: 'object', properties: { service: { type: 'string', enum: ['old'] }, barber: { type: 'string', enum: ['Old'] }, customer_name: { type: 'string' }, date: { type: 'string' }, time: { type: 'string' }, phone: { type: 'string' } }, required: ['customer_name', 'date', 'time', 'phone'] },
      },
    },
  }));
  let agentPrompt = { prompt: 'old', tool_ids: [] };
  let firstMessage = 'old greeting';
  let maxDurationSeconds;
  let maxDurationMessage;
  const oldFetch = global.fetch;
  const oldKey = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = 'test-only';
  global.fetch = async (url, options) => {
    const endpoint = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    let result;
    if (endpoint.endsWith('/agents/agent_new') && options.method === 'GET') result = { conversation_config: { conversation: { max_duration_seconds: maxDurationSeconds }, agent: { first_message: firstMessage, prompt: agentPrompt, max_conversation_duration_message: maxDurationMessage } } };
    else if (endpoint.endsWith('/agents/agent_new') && options.method === 'PATCH') {
      agentPrompt = body.conversation_config.agent.prompt;
      firstMessage = body.conversation_config.agent.first_message;
      maxDurationSeconds = body.conversation_config.conversation.max_duration_seconds;
      maxDurationMessage = body.conversation_config.agent.max_conversation_duration_message;
      result = { ok: true };
    }
    else if (endpoint.endsWith('/tools') && options.method === 'GET') result = { tools, has_more: false };
    else if (endpoint.endsWith('/tools') && options.method === 'POST') { result = { id: `created_${tools.length}`, tool_config: body.tool_config }; tools.push(result); }
    else if (/\/tools\/[^/]+$/.test(endpoint) && options.method === 'PATCH') {
      const id = endpoint.split('/').at(-1);
      const existing = tools.find((tool) => tool.id === id);
      existing.tool_config = body.tool_config;
      result = existing;
    }
    else if (endpoint.endsWith('/secrets') && options.method === 'POST') result = { secret_id: 'new-secret-id' };
    else throw new Error(`Unexpected mock API: ${options.method} ${endpoint}`);
    return { ok: true, json: async () => result };
  };
  try {
    const result = await provisionSalon(db, {
      id: 'novi-salon', name: 'Novi salon', agent_id: 'agent_new', knowledge_notes: 'Radi samo po zakazivanju.',
    }, ['manikir'], ['Jana']);
    assert.deepEqual(result.tools, names);
    assert.equal(db.prepare('SELECT integration_ready FROM salons WHERE id = ?').get('novi-salon').integration_ready, 1);
    assert.equal(tools.length, 6);
    assert.ok(tools.slice(3).every((tool) => tool.tool_config.api_schema.request_headers['X-Salon-Id'] === 'novi-salon'));
    assert.ok(tools.slice(3).every((tool) => tool.tool_config.api_schema.request_headers['X-Agent-Secret'].secret_id === 'new-secret-id'));
    const availabilityTool = tools.slice(3).find((tool) => tool.tool_config.name === 'check_availability');
    assert.equal(availabilityTool.tool_config.api_schema.request_body_schema.properties.phone.type, 'string');
    assert.ok(!(availabilityTool.tool_config.api_schema.request_body_schema.required || []).includes('phone'));
    assert.deepEqual(agentPrompt.tool_ids, tools.slice(3).map((tool) => tool.id));
    assert.match(agentPrompt.prompt, /Novi salon/);
    assert.match(agentPrompt.prompt, /Radi samo po zakazivanju/);
    assert.match(agentPrompt.prompt, /Jana/);
    assert.match(agentPrompt.prompt, /najviše DVA najbliža termina/);
    assert.match(agentPrompt.prompt, /neposredno pre završne potvrde pozovi check_availability još jednom/);
    assert.match(agentPrompt.prompt, /Ne nudi ponoć kao alternativu/);
    assert.match(agentPrompt.prompt, /NEED_STAFF NIJE potvrda dostupnosti/);
    assert.match(agentPrompt.prompt, /samo završnu, kratku repliku/);
    assert.ok(agentPrompt.prompt.indexOf('Recite mi broj telefona') < agentPrompt.prompt.indexOf('Kako se zovete'));
    assert.match(agentPrompt.prompt, /Nemoj još tražiti ime/);
    assert.equal(agentPrompt.llm, 'gpt-4.1-mini');
    assert.equal(agentPrompt.thinking_budget, null);
    assert.equal(agentPrompt.reasoning_effort, null);
    assert.equal(agentPrompt.enable_reasoning_summary, false);
    assert.ok(availabilityTool.tool_config.description.includes('najviše dva najbliža'));
    const cancellationTool = tools.slice(3).find((tool) => tool.tool_config.name === 'cancel_appointment');
    assert.equal(cancellationTool.tool_config.api_schema.request_body_schema.properties.customer_name, undefined);
    assert.deepEqual(cancellationTool.tool_config.api_schema.request_body_schema.required.sort(), ['date', 'phone', 'time']);
    assert.equal(maxDurationSeconds, 90);
    assert.equal(firstMessage, 'Dobar dan, kako mogu da vam pomognem?');
    assert.equal(maxDurationMessage, 'Vreme razgovora je isteklo. Hvala, prijatno.');
  } finally {
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = oldKey;
    db.close();
  }
});
