const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('ELEVENLABS_API_KEY nedostaje');
const db = new DatabaseSync(process.env.BOOKING_DB_FILE || path.join(__dirname, '..', 'appointments.db'));
const selected = process.argv[2];
const salons = db.prepare('SELECT id,agent_id FROM salons WHERE agent_id <> ?').all('').filter((salon) => !selected || salon.id === selected);
if (selected && salons.length !== 1) throw new Error('Nepoznat salon');

async function agentRequest(method, id, body) {
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${id}`, {
    method,
    headers: { 'xi-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${id}: HTTP ${response.status}`);
  return response.json();
}

(async () => {
  for (const salon of salons) {
    const before = await agentRequest('GET', salon.agent_id);
    const prompt = before.conversation_config?.agent?.prompt;
    const original = prompt?.prompt;
    if (!original || !Array.isArray(prompt.tool_ids)) throw new Error(`${salon.id}: prompt nije dostupan`);
    const oldRule = /^Ako cancel_appointment vrati code=CUSTOMER_WEEKLY_CANCEL_LIMIT, reci:.*$/m;
    if (!oldRule.test(original)) throw new Error(`${salon.id}: staro pravilo nije nađeno; preskačem da ne prepišem nepoznat prompt`);
    const newRule = 'Ako cancel_appointment vrati code=CUSTOMER_WEEKLY_CANCEL_LIMIT, reci: „Već ste jednom otkazali termin u poslednjih sedam dana. Za ovo otkazivanje, molim vas kontaktirajte salon; vlasnik može da vam pomogne.“ Ne pozivaj cancel_appointment ponovo. Posle prvog otkazivanja korisnik može ponovo da zakaže, ali ne može drugi put sam da otkaže u istih sedam dana.';
    const updatedText = original.replace(oldRule, newRule) + '\nAko check_availability vrati reason da je datum prošao ili da zaposleni ne radi, objasni to umesto da kažeš da su svi termini zauzeti. Ako book_appointment vrati ok=false i code=OUTSIDE_HOURS, reci da termin nije u radnom vremenu ili je pauza i proveri drugi dan ili sat.\n';
    await agentRequest('PATCH', salon.agent_id, { conversation_config: { agent: { prompt: { prompt: updatedText } } } });
    const after = await agentRequest('GET', salon.agent_id);
    const afterPrompt = after.conversation_config?.agent?.prompt;
    if (afterPrompt?.prompt !== updatedText || JSON.stringify(afterPrompt.tool_ids) !== JSON.stringify(prompt.tool_ids)) {
      throw new Error(`${salon.id}: promena prompta ili očuvanje alata nije potvrđeno`);
    }
    console.log(`${salon.id}: prompt ažuriran; alati očuvani`);
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
