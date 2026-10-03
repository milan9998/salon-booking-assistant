# ElevenLabs TXT booking demo

Mali testni API sa SQLite bazom. Rezervacije se cuvaju u `appointments.db`.

## Pokretanje

Čuvaj podešavanja u lokalnom `.env` na D: disku. Postavi nasumičnu
`ADMIN_PASSWORD` i ElevenLabs API ključ, pa pokreni:

```powershell
node --env-file=.env server.js
```

Proveru ElevenLabs ključa pokreni bez prikazivanja samog ključa:

```powershell
node --env-file=.env scripts/check-elevenlabs.js
```

ElevenLabs API ključ služi samo backendu. Svaki salon koristi svoju
odvojenu tajnu za webhook; stari zajednički `BOOKING_API_SECRET` je isključen
u živom režimu. Testovi koriste izdvojenu bazu i eksplicitni testni režim.

API se pokrece na `http://127.0.0.1:8787` (za naš test koristi se port `18787`). Baza se automatski napravi pri prvom pokretanju.

## Lokalni kalendar

Otvoriti `http://127.0.0.1:18787/`. Platform admin je `admin`, a lozinka
je u lokalnom `.env`. Svaki vlasnik dobija poseban nalog samo za svoj salon.
Kalendar prikazuje potvrđene i otkazane termine, a osvežava se i automatski.
Posle prijave možeš da izabereš salon ili klikneš **Dodaj salon**. Za svaki novi
salon unosi se njegov ručno kreirani ElevenLabs `agent_id`; termini i osoblje su
odvojeni po salonu.
Na vrhu kalendara je i dugme **Pozovi agenta**. Ono otvara ElevenLabs web widget
za trenutno izabrani salon, pa možeš da testiraš isti razgovor bez telefonskog
broja. Agent mora biti javan i imati isključenu autentikaciju za widget.
Vlasnik može da otkaže termin u kalendaru. Dugme **Radno vreme** podešava
radne dane, sate i pauze.

### Povezivanje novog agenta

1. U ElevenLabs ručno napravi novi agent i kopiraj njegov `agent_id` (to nije API ključ).
2. U lokalnom kalendaru klikni **Dodaj salon**, unesi naziv, `agent_id`, osoblje i usluge.
3. Klikni **Poveži alate i znanje**. Ovaj korak zamenjuje prompt tog agenta
   šablonom sa podacima salona i pravi tri odvojena webhook alata i tajnu.
4. Tek kada piše **Alati povezani**, testiraj **Pozovi agenta**.

URL-ovi mogu ostati isti, ali samo `X-Salon-Id` nije dovoljna zaštita:
server proverava i posebnu tajnu tog salona. Quick Tunnel menja URL posle
novog tunela i tada URL-ove alata treba ažurirati.

## Endpointi

- `GET /health`
- `GET /api/services`
- `GET /api/appointments`
- `GET /api/admin/salons` (zahteva admin Bearer sesiju)
- `POST /api/admin/salons` (zahteva admin Bearer sesiju)
- `POST /api/admin/salons/:id/provision` (samo platform admin)
- `POST /api/admin/owners` (samo platform admin)
- `PATCH /api/salons/:id/schedule` (vlasnik svog salona ili platform admin)
- `POST /api/owner/cancel-appointment` (vlasnik svog salona ili platform admin)
- `POST /api/check-availability`
- `POST /api/book-appointment`
- `POST /api/cancel-appointment`
- `POST /api/login`

Webhook zahtevi nose `X-Agent-Secret` (posebnu tajnu za salon) i
`X-Salon-Id`. Administratorski API koristi Bearer sesiju.

Webhook agenta bira salon preko zaglavlja `X-Salon-Id`. To zaglavlje treba da
bude različito u alatima svakog agenta (vrednost je ID prikazan pored izabranog
salona u kalendaru). Server dodatno proverava da tajna pripada baš tom salonu.

### Provera termina

```json
{
  "date": "2031-04-15",
  "service": "sisanje",
  "barber": "Marko"
}
```

### Rezervacija

```json
{
  "date": "2031-04-15",
  "time": "16:30",
  "service": "sisanje",
  "barber": "Marko",
  "customer_name": "Petar Petrovic",
  "phone": "+381641234567"
}
```

### Otkazivanje

```json
{
  "date": "2031-04-15",
  "time": "16:30",
  "customer_name": "Petar Petrovic",
  "phone": "+381641234567"
}
```

Telefon se poredi normalizovano, pa rade i međunarodni `+381...` i lokalni `06...` format.

## Testovi

Izolovani testovi koriste posebnu privremenu bazu i port `18887`, pa ne menjaju
`appointments.db` niti aktivni lokalni API:

```powershell
node --test test/*.test.js
```

Za povezivanje sa ElevenLabs webhook alatima API mora biti javno dostupan preko
HTTPS adrese. Za privremeni test moze se koristiti Cloudflare Tunnel.

## Pravila otkazivanja i ograničenje testa

Za otkazivanje preko agenta moraju da se poklope salon, datum, vreme i broj
telefona sa jednim postojećim potvrđenim terminom. Ime se ne proverava, jer
prepoznavanje govora može da ga pogreši. Ako se poklopi više termina, agent
ne otkazuje nijedan već upućuje vlasniku. Mušterija može sama da otkaže
jedan termin u sedam dana, pa zatim opet da
rezerviše. Drugo samostalno otkazivanje u tom periodu nije dozvoljeno;
agent upućuje da kontaktira salon, a vlasnik može otkazati iz kalendara.
Za sada nema SMS-a, PIN-a niti stvarne telefonske linije. Izgovoreni broj
telefona nije potvrđen identitet, pa ni ovi podaci nisu dovoljni
kao potvrda identiteta za javnu produkciju.
