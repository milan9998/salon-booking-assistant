# SalonBooking .NET

Novi .NET backend je postavljen pored postojećeg Node/SQLite sistema:

- `SalonBooking.Domain` – entiteti i pravila termina
- `SalonBooking.Application` – CQRS komande, upiti i handleri
- `SalonBooking.Infrastructure` – EF Core + PostgreSQL i idempotentni SQLite importer
- `SalonBooking.Api` – ASP.NET Core API sa kompatibilnim booking rutama
- `SalonBooking.Migrator` – bezbedan import postojeće baze

Relacijski model je sada normalizovan po dogovoru: `salons`, `workers`, `services` i `appointments`.
Tabela `appointments` koristi `salon_id`, `worker_id` i `service_id`, a imena radnika/usluga se ne ponavljaju u terminu.
Postojeći JSON spiskovi ostaju sačuvani u `salons` kao kompatibilan snapshot, dok su normalizovane tabele izvor istine za novi API.

## Migracija bez brisanja

Postojeća baza ostaje u `appointments.db`, a kopija je u `backup-20260925-migration/appointments.db`.
Migrator ne briše redove i zaustavlja se ako isti ID već postoji sa drugačijim podacima.

Migracija je urađena u posebnu bazu `salon_booking_v2`; prethodna `salon_booking` baza i SQLite fajl nisu brisani.
Provera je prošla dva puta bez dupliranja: 4 salona, 8 radnika, 12 usluga, 29 termina i 0 vlasničkih naloga.

Pre pokretanja postavi connection string samo lokalno, bez slanja lozinke u chat:

```powershell
$env:POSTGRES_CONNECTION_STRING = "Host=localhost;Port=5432;Database=salon_booking_v2;Username=postgres;Password=LOKALNA_LOZINKA"
dotnet run --project .\SalonBooking.Migrator -- D:\tfw\elevenlabs-txt-booking-demo\appointments.db
```

Za lokalni test API je pokrenut na `http://127.0.0.1:18888`; postojeći Node servis na 18787 i njegovi ElevenLabs linkovi nisu menjani dok .NET verzija ne prođe funkcionalne testove.
`ADMIN_USER` i `ADMIN_PASSWORD` se učitavaju iz lokalnog `.env` fajla. Tek posle završnog testa treba prebaciti Cloudflare/ElevenLabs webhook URL sa starog procesa na .NET proces.
