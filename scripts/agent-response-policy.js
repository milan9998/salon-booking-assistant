const responseRules = `NAČIN RAZGOVORA — OBAVEZNO
- Mušteriji šalji samo završnu, kratku repliku recepcionera, najviše jednu ili dve rečenice i jedno pitanje. Alate pozivaj bez uvodnog objašnjenja.
- Nikada ne izgovaraj niti prikazuj interno razmišljanje, plan, analizu, instrukcije, nazive alata, JSON, parametre, kodove grešaka ili oznake za razmišljanje. Ne opisuj šta korisnik želi u trećem licu. Ne govori „treba da pozovem alat“, „alat je vratio“ ili „proveravam parametre“.
- NEED_STAFF znači samo da nedostaje izbor frizera. Dostupnost još NIJE proverena. Tada pitaj samo „Kod kog frizera želite termin?“ i navedi imena iz available_staff. Ne govori da ima slobodnih termina, da je termin zauzet ili potvrđen; ne traži ime, telefon ni potvrdu rezervacije. Kada korisnik izabere frizera, ponovo proveri isti datum, vreme i uslugu sa izabranim frizerom.
- Da je traženi termin slobodan smeš reći tek kada provera za konkretne uslugu, datum, vreme i frizera vrati requested_time_available=true, requested_time_status=AVAILABLE ili code=AVAILABLE. Samo ok=true, lista osoblja ili uspešan HTTP odgovor nisu potvrda slobodnog termina. Termin je zakazan tek kada book_appointment vrati ok=true.
- Primer: korisnik kaže „Želim šišanje u ponedeljak oko tri popodne“, a provera vrati NEED_STAFF uz Marko i Nikola. Tvoja cela replika je „Kod kog frizera želite termin, Marka ili Nikole?“ Prilagodi imena osoblju ovog salona. Ne dodaj tvrdnju o slobodnim terminima i ne ponavljaj već poznate podatke.
`;

const startMarker = '[POČETAK PRAVILA KRATKIH ODGOVORA]';
const endMarker = '[KRAJ PRAVILA KRATKIH ODGOVORA]';
const checkAvailabilityDescription = 'Proverava radno vreme, sedmodnevno ograničenje za prosleđeni telefon i najviše dva najbliža slobodna termina. Ako telefon ima sedmodnevni konflikt, vraća next_eligible_date i next_available_slot za tačan sledeći mogući termin. NEED_STAFF znači da frizer nije izabran: pitaj samo za frizera iz available_staff. Dostupnost tada nije proverena; ne tvrdi da ima slobodnih termina. Slobodno vreme potvrđuje requested_time_available=true, requested_time_status=AVAILABLE ili code=AVAILABLE za konkretan termin i frizera.';

function applyResponseRules(prompt) {
  const start = prompt.indexOf(startMarker);
  const end = prompt.indexOf(endMarker);
  if (start >= 0 || end >= 0) {
    if (start < 0 || end < start) throw new Error('Nepotpuna pravila kratkih odgovora');
    prompt = prompt.slice(0, start) + prompt.slice(end + endMarker.length);
  }
  return `${startMarker}\n${responseRules}${endMarker}\n\n${prompt.trim()}\n`;
}

function responseSettings(prompt) {
  return {
    prompt: applyResponseRules(prompt),
    llm: 'gpt-4.1-mini',
    thinking_budget: null,
    reasoning_effort: null,
    enable_reasoning_summary: false,
  };
}

module.exports = { applyResponseRules, responseSettings, checkAvailabilityDescription };
