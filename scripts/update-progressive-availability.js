const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('ELEVENLABS_API_KEY nedostaje');
const db = new DatabaseSync(process.env.BOOKING_DB_FILE || path.join(__dirname, '..', 'appointments.db'));
const salons = db.prepare('SELECT id,agent_id FROM salons WHERE integration_ready = 1').all();
const marker = 'RANA PROVERA TERMINA — NAJVIŠI PRIORITET';

async function api(method, endpoint, body) {
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/${endpoint}`, {
    method,
    headers: { 'xi-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${method} ${endpoint}: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.json();
}

function updatePrompt(original, salonId) {
  if (original.includes(marker)) return original;
  let text = original;
  if (salonId === 'default') {
    const start = text.indexOf('Čim su poznati usluga, datum i frizer, odmah pozovi:');
    const end = text.indexOf('# IME I TELEFON', start);
    if (start < 0 || end < 0) throw new Error(`${salonId}: stari odeljak dostupnosti nije nađen`);
    text = text.slice(0, start) + text.slice(end);
  } else {
    const old = [
      'Za proveru su potrebni usluga, datum i član osoblja. Vreme može biti poznato odmah ili se bira iz slobodnih termina.',
      'Čim znaš uslugu, datum i osoblje, jednom pozovi check_availability. Ne traži potvrdu pre poziva.',
      'Koristi samo termine koje alat vrati i pročitaj najviše tri. Ako je korisnikovo vreme slobodno, pređi na ime i telefon. Ako je zauzeto, ponudi najviše tri nova termina. Ako nema termina, reci to kratko i ponudi drugi termin ili osoblje.',
    ];
    for (const line of old) {
      if (!text.includes(line)) throw new Error(`${salonId}: staro pravilo nije nađeno`);
      text = text.replace(line, '');
    }
  }
  const rule = `\n${marker}
Čim saznaš uslugu i datum, pozovi check_availability sa date i service; ako je korisnik rekao i vreme, obavezno pošalji time u formatu HH:MM. Ne čekaj ime ili broj telefona. Ako je osoblje poznato, pošalji i barber. Ako alat vrati NEED_STAFF, pitaj samo kog zaposlenog želi, pa odmah ponovi proveru sa svim poznatim podacima, naročito time. Ako je korisniku svejedno, uzmi prvog zaposlenog sa spiska salona i proveri ponovo.
Ako korisnik posle provere promeni datum, vreme, uslugu ili zaposlenog, ponovo pozovi check_availability pre daljih pitanja. Ime i broj telefona traži tek kada je traženo vreme potvrđeno kao requested_time_status=AVAILABLE, ili je korisnik izabrao vreme iz available_slots.
Odgovor zasnivaj na tačnom kodu alata: OUTSIDE_HOURS znači da traženo vreme nije u radnom vremenu; reci konkretno working_hours.start, working_hours.end i last_start ako postoji. ON_BREAK znači pauzu, CLOSED_DAY neradni dan, PAST_DATE/PAST_TIME prošlost, INVALID_TIME nevažeći početak, SLOT_TAKEN stvarno zauzet termin. Samo SLOT_TAKEN smeš nazvati zauzetim. Ne govori da su svi termini zauzeti ako je problem radno vreme ili pauza. Kod NEED_STAFF nije dokaz dostupnosti. Ne izmišljaj radno vreme, već pročitaj vrednosti iz alata.
Ako book_appointment naknadno vrati ok=false, koristi njegov tačan code i error; ne potvrđuj rezervaciju. Kada vrati OUTSIDE_HOURS, ON_BREAK, CLOSED_DAY ili PAST_TIME, reci konkretan error, ne „zauzeto“.
`;
  return `${text.trimEnd()}${rule}`;
}

(async () => {
  const listing = await api('GET', 'tools?page_size=100');
  if (listing.has_more) throw new Error('Lista alata nije potpuna');
  if (salons.length !== 4) throw new Error(`Očekivana su četiri aktivna salona, nađeno ${salons.length}`);
  for (const salon of salons) {
    const agent = await api('GET', `agents/${salon.agent_id}`);
    const settings = agent.conversation_config?.agent?.prompt;
    if (!settings?.prompt || !Array.isArray(settings.tool_ids)) throw new Error(`${salon.id}: agent nema prompt ili tool_ids`);
    const matches = listing.tools.filter((item) => settings.tool_ids.includes(item.id) && item.tool_config?.name === 'check_availability');
    if (matches.length !== 1) throw new Error(`${salon.id}: očekivan je tačno jedan check_availability alat`);
    const tool = matches[0];
    const config = structuredClone(tool.tool_config);
    const schema = config.api_schema?.request_body_schema;
    if (!schema?.required?.includes('date') || !schema.required.includes('service') || !schema.properties?.barber) {
      throw new Error(`${salon.id}: neočekivana šema alata`);
    }
    schema.required = ['date', 'service'];
    schema.properties.barber.description = `${schema.properties.barber.description} Opciono ako korisnik još nije izabrao zaposlenog.`;
    schema.properties.time = {
      type: 'string', description: 'Traženo vreme u formatu HH:MM, ako ga je korisnik rekao. Pošalji ga odmah radi provere radnog vremena i zauzetosti.',
      enum: null, is_system_provided: false, dynamic_variable: '', allowed_values: null,
      allowed_values_dynamic_variable: '', constant_value: '', is_omitted: false,
    };
    if (!tool.tool_config.api_schema?.request_body_schema?.properties?.time) {
      await api('PATCH', `tools/${tool.id}`, { tool_config: config });
    }
    const verifiedTool = await api('GET', `tools/${tool.id}`);
    const verifiedSchema = verifiedTool.tool_config?.api_schema?.request_body_schema;
    if (!verifiedSchema?.properties?.time || verifiedSchema.required.includes('barber') ||
        (verifiedTool.tool_config.api_schema.request_headers['X-Salon-Id'] || 'default') !== salon.id) {
      throw new Error(`${salon.id}: šema ili veza alata nisu potvrđene`);
    }
    const updatedPrompt = updatePrompt(settings.prompt, salon.id);
    if (updatedPrompt !== settings.prompt) await api('PATCH', `agents/${salon.agent_id}`, { conversation_config: { agent: { prompt: { prompt: updatedPrompt } } } });
    const after = await api('GET', `agents/${salon.agent_id}`);
    const afterSettings = after.conversation_config?.agent?.prompt;
    if (afterSettings?.prompt !== updatedPrompt || JSON.stringify(afterSettings.tool_ids) !== JSON.stringify(settings.tool_ids)) {
      throw new Error(`${salon.id}: prompt ili dodela alata nisu potvrđeni`);
    }
    console.log(`${salon.id}: vreme i rana provera dodati; dodela alata očuvana`);
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
