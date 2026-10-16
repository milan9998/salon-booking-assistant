# Pregled i ispravke — 16.10.2026.

## Konkretan incident sa otkazivanjem

Zapis ElevenLabs razgovora pokazao je dva različita rezultata: prvi zahtev je imao pogrešno prepoznat datum 6. oktobar i stvarno nije našao termin. Posle ispravke na 26. oktobar, backend je našao termin, ali vratio `CUSTOMER_WEEKLY_CANCEL_LIMIT` kao HTTP 404. ElevenLabs je zato prosledio agentu transportnu grešku umesto poslovnog rezultata, a agent je ponovio da termin ne postoji.

Ruta sada vraća HTTP 200 uz `ok=false` i tačan `code` za očekivane poslovne ishode. Nevažeća autentikacija ostaje HTTP 401. Postojeći termini nisu otkazivani radi ovog pregleda.

## Otkriveni i rešeni propusti

| Propust | Ispravka |
| --- | --- |
| .NET provera dostupnosti ignorisala je `phone` | Polje je uvedeno kroz API zahtev i CQRS upit; provera telefona i nedeljnog limita radi pre završne potvrde |
| Alternativni datum nije prolazio sedmodnevno pravilo | Zajednički `BookingEligibilityService` računa tačan dozvoljeni datum i traži stvarno slobodan termin kod izabranog zaposlenog |
| Knjiženje i rana provera imale su različita pravila | Ista usluga koristi se u upitu i u transakciji upisa; oba odgovora mogu vratiti `next_eligible_date` i `next_available_slot` |
| Otkazivanje slalo je poslovne zabrane kao 404 | Čitljiv JSON rezultat sa HTTP 200; limit, pogrešan broj i nenalaženje termina imaju različite kodove |
| Dva paralelna otkazivanja mogla su proći isti limit | PostgreSQL transakcija i zaključavanje normalizovanog telefona; isto zaključavanje koristi i vlasničko otkazivanje |
| Lokalni i međunarodni telefoni nisu svuda bili isti | Zajednička normalizacija `06`, `+3816`, `003816`, razmaka i crtica |
| Mogli su se nuditi današnji prošli sati | Datum i vreme proveravaju se u vremenskoj zoni salona |
| Računanje vremena moglo se prelomiti preko ponoći | Trajanje i preklapanje računaju se u minutima; generator termina je ograničen krajem radnog vremena |
| Prazno ime prolazilo je upis | Validacija imena pre upisa |
| Raspored je prihvatao nevažeće sate i pauze | Validacija dana, prozora rada, pauza i zaposlenih pre čuvanja |
| Javni spisak salona nije proveravao pristup | Prijava je obavezna; vlasnik dobija samo svoj salon |
| Prazna admin lozinka mogla je važiti bez konfiguracije | Prazna konfiguracija ne može autentifikovati administratora |
| Frontend je pozivao nepostojeću .NET rutu za povezivanje agenta | Dodat kontroler i .NET ElevenLabs servis sa proverom posebnih alata/tajne po salonu, potvrdom podešavanja i ponovljivim pokušajem |
| Operativne skripte čitale su zastarelu SQLite kopiju | Aktivne komande za tunele i agente sada čitaju zaštićeni .NET administratorski pregled PostgreSQL podataka |
| Zakasneli odgovor kalendara mogao je prikazati podatke prethodnog salona | Rezultat se primenjuje samo ako salon, sesija i redni broj zahteva i dalje odgovaraju |
| Putanje statičkog frontenda i `.env` zavisile su od tačno određenog radnog direktorijuma | Pokretanje pronalazi koren booking projekta |

## Provere

Rezultat završnog pokretanja: 17/17 .NET testova i 15/15 aktivnih JavaScript testova. Aplikacija je ponovo pokrenuta na `127.0.0.1:18787`; PostgreSQL ima ista 4 salona i svih 34 termina. Potpun skup zapisa termina upoređen je pre i posle restarta i ostao je nepromenjen.

Živa API provera za 20. oktobar, izabranog Marka i broj iz prijavljenog problema vraća `CUSTOMER_WEEKLY_LIMIT` već u proveri dostupnosti, sa sledećim dozvoljenim datumom 2. novembar i slobodnim terminom u 09:00. Termin za 26. oktobar u 10:00 ostao je potvrđen. Postoji jedno korisničko otkazivanje u prethodnih sedam dana, pa njegovo novo samostalno otkazivanje treba odbiti tačnim objašnjenjem, dok vlasnik zadržava mogućnost otkazivanja.

Javni Cloudflare tunel, sva četiri postojeća agenta, njihove zasebne tajne i konfiguracije razgovora provereni su nakon restarta.

.NET testovi proveravaju stvarne PostgreSQL upite i zaključavanja u zasebnim privremenim bazama, uključujući paralelne rezervacije, paralelna otkazivanja, nedeljne zabrane, alternativne termine, međunarodne telefone i izolaciju vlasničkih naloga. Testovi povezivanja agenta koriste kontrolisanu imitaciju ElevenLabs HTTP API-ja i proveravaju prvi pokušaj, ponovljeni pokušaj i odbijanje tuđih alata. Ne kreiraju nove salone/agente na stvarnom ElevenLabs nalogu.

Legacy Node/frontend testovi proveravaju zaseban sačuvani Node sistem i deo JavaScript ponašanja. Njihov rezultat ne zamenjuje .NET testove.

Živi govor, prepoznavanje izgovorenih datuma i poštovanje prompta proveravaju se dodatnim pozivom. Ovaj pregled ne tvrdi da je svako buduće govorno ponašanje pokriveno automatskim testom.
