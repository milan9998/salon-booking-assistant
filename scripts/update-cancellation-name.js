const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('ELEVENLABS_API_KEY nedostaje');
const db = new DatabaseSync(process.env.BOOKING_DB_FILE || path.join(__dirname, '..', 'appointments.db'));
const salons = db.prepare('SELECT id,agent_id FROM salons WHERE integration_ready = 1').all();

async function agentRequest(method, id, body) {
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${id}`, {
    method, headers: { 'xi-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${id}: HTTP ${response.status}`);
  return response.json();
}

function replaceRequired(text, before, after, salonId) {
  if (!text.includes(before)) throw new Error(`${salonId}: očekivano staro pravilo nije nađeno`);
  return text.replace(before, after);
}

(async () => {
  for (const salon of salons) {
    const before = await agentRequest('GET', salon.agent_id);
    const settings = before.conversation_config?.agent?.prompt;
    if (!settings?.prompt || !Array.isArray(settings.tool_ids)) throw new Error(`${salon.id}: prompt ili alati nisu dostupni`);
    let prompt = settings.prompt;
    if (salon.id === 'default') {
      prompt = replaceRequired(prompt,
        'Za otkazivanje su potrebni samo:\n- datum\n- vreme\n- broj telefona',
        'Za otkazivanje su potrebni ime pod kojim je termin zakazan, datum, vreme i broj telefona. Ako nešto nedostaje, pitaj samo za taj podatak.', salon.id);
      prompt = replaceRequired(prompt, 'Ne traži uslugu, frizera, ime niti novu rezervaciju.',
        'Ne traži uslugu, frizera niti novu rezervaciju.', salon.id);
      prompt = replaceRequired(prompt, 'Čim imaš datum, vreme i validan broj telefona, odmah pozovi:',
        'Čim imaš ime, datum, vreme i validan broj telefona, odmah pozovi:', salon.id);
      prompt = replaceRequired(prompt, 'Proverite datum, vreme i broj telefona.',
        'Proverite ime, datum, vreme i broj telefona.', salon.id);
    } else {
      prompt = replaceRequired(prompt,
        'Tada su potrebni samo datum, vreme i broj telefona; ne traži uslugu, osoblje ni ime.',
        'Tada su potrebni ime pod kojim je termin zakazan, datum, vreme i broj telefona; ne traži uslugu ni osoblje.', salon.id);
      prompt = replaceRequired(prompt, 'Čim imaš ta tri podatka i validan telefon, pozovi cancel_appointment',
        'Čim imaš sva četiri podatka i validan telefon, pozovi cancel_appointment', salon.id);
    }
    prompt += '\nNAJVIŠI PRIORITET ZA OTKAZIVANJE: Uvek prikupi i pošalji customer_name, date, time i phone. Otkazivanje potvrdi samo kada cancel_appointment vrati ok=true. Ako se podaci ne poklapaju, zamoli korisnika da proveri ime, datum, vreme i broj; ne izmišljaj niti nagađaj podatke.\n';
    await agentRequest('PATCH', salon.agent_id, { conversation_config: { agent: { prompt: { prompt } } } });
    const after = await agentRequest('GET', salon.agent_id);
    const afterSettings = after.conversation_config?.agent?.prompt;
    if (afterSettings?.prompt !== prompt || JSON.stringify(afterSettings.tool_ids) !== JSON.stringify(settings.tool_ids)) {
      throw new Error(`${salon.id}: novo pravilo ili stari alati nisu potvrđeni`);
    }
    console.log(`${salon.id}: agent traži ime, datum, vreme i telefon; alati očuvani`);
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
