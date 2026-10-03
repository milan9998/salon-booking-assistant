using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using SalonBooking.Domain.Booking;
using SalonBooking.Domain.Entities;

namespace SalonBooking.Infrastructure.Persistence;

public sealed class SqliteDataImporter(BookingDbContext postgres)
{
    public async Task<MigrationSummary> ImportAsync(string sqliteFile, CancellationToken cancellationToken = default)
    {
        await postgres.Database.EnsureCreatedAsync(cancellationToken);
        await using var sqlite = new SqliteConnection($"Data Source={sqliteFile};Mode=ReadOnly");
        await sqlite.OpenAsync(cancellationToken);
        await using var transaction = await postgres.Database.BeginTransactionAsync(cancellationToken);

        var salons = await ReadSalons(sqlite, cancellationToken);
        var sourceAppointments = await ReadSourceAppointments(sqlite, cancellationToken);
        foreach (var source in salons)
        {
            var current = await postgres.Salons.SingleOrDefaultAsync(x => x.Id == source.Id, cancellationToken);
            if (current is null) postgres.Salons.Add(source);
            else if (!EquivalentIdentity(current, source)) throw new InvalidOperationException($"Salon {source.Id} ima različit identitet, raspored ili tajnu; import je zaustavljen bez prepisivanja.");
            else current.UpdateProfile(source.Name, source.ServicesJson, source.KnowledgeNotes);
        }
        await postgres.SaveChangesAsync(cancellationToken);

        var workers = new List<Worker>();
        var services = new List<SalonService>();
        var workerMap = new Dictionary<(string SalonId, string Name), Worker>();
        var serviceMap = new Dictionary<(string SalonId, string Name), SalonService>();
        foreach (var salon in salons)
        {
            foreach (var name in ReadNames(salon.BarbersJson))
            {
                var worker = new Worker(StableId(salon.Id, "worker", name), salon.Id, name);
                var current = await postgres.Workers.SingleOrDefaultAsync(x => x.Id == worker.Id, cancellationToken);
                if (current is null) { postgres.Workers.Add(worker); current = worker; }
                else if (current.SalonId != worker.SalonId || current.Name != worker.Name) throw new InvalidOperationException($"Radnik {worker.Id} već postoji sa različitim podacima.");
                workers.Add(current);
                workerMap[(salon.Id, name)] = current;
            }
            var activeNames = ReadNames(salon.ServicesJson).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var historicalNames = sourceAppointments.Where(x => x.SalonId == salon.Id).Select(x => x.Service);
            var allNames = activeNames.Concat(historicalNames).Distinct(StringComparer.OrdinalIgnoreCase);
            var existingServices = await postgres.Services.Where(x => x.SalonId == salon.Id).ToListAsync(cancellationToken);
            foreach (var existing in existingServices) existing.SetActive(activeNames.Contains(existing.Name));
            foreach (var name in allNames)
            {
                var duration = BookingPolicy.Durations.TryGetValue(name, out var known) ? known : 30;
                var service = new SalonService(StableId(salon.Id, "service", name), salon.Id, name, duration, activeNames.Contains(name));
                var current = await postgres.Services.SingleOrDefaultAsync(x => x.Id == service.Id, cancellationToken);
                if (current is null) { postgres.Services.Add(service); current = service; }
                else if (current.SalonId != service.SalonId || current.Name != service.Name || current.DurationMinutes != service.DurationMinutes) throw new InvalidOperationException($"Usluga {service.Id} već postoji sa različitim podacima.");
                else current.SetActive(activeNames.Contains(name));
                services.Add(current);
                serviceMap[(salon.Id, name)] = current;
            }
        }
        await postgres.SaveChangesAsync(cancellationToken);

        foreach (var source in sourceAppointments)
        {
            var worker = Resolve(workerMap, source.SalonId, source.Barber);
            var service = Resolve(serviceMap, source.SalonId, source.Service);
            if (worker is null || service is null) throw new InvalidOperationException($"Termin {source.Id} nema poznatog radnika ili uslugu.");
            var appointment = new Appointment(source.Id, source.Status, source.SalonId, worker.Id, service.Id, source.Date, source.Time,
                source.CustomerName, source.Phone, source.CreatedAt, source.CancelledAt, source.CancelledBy);
            var current = await postgres.Appointments.FindAsync([source.Id], cancellationToken);
            if (current is null) postgres.Appointments.Add(appointment);
            else if (current.SalonId != appointment.SalonId || current.WorkerId != appointment.WorkerId || current.ServiceId != appointment.ServiceId || current.Date != appointment.Date || current.Time != appointment.Time || current.Status != appointment.Status)
                throw new InvalidOperationException($"Termin {source.Id} već postoji sa različitim podacima; import je zaustavljen.");
        }
        await postgres.SaveChangesAsync(cancellationToken);

        var owners = await ReadOwners(sqlite, cancellationToken);
        foreach (var source in owners)
        {
            var current = await postgres.OwnerAccounts.FindAsync([source.Username], cancellationToken);
            if (current is null) postgres.OwnerAccounts.Add(source);
            else if (current.SalonId != source.SalonId || current.PasswordHash != source.PasswordHash) throw new InvalidOperationException($"Vlasnički nalog {source.Username} već postoji sa različitim podacima; import je zaustavljen.");
        }
        await postgres.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        return new(salons.Count, workers.Count, services.Count, sourceAppointments.Count, owners.Count,
            await postgres.Salons.CountAsync(cancellationToken), await postgres.Workers.CountAsync(cancellationToken),
            await postgres.Services.CountAsync(cancellationToken), await postgres.Appointments.CountAsync(cancellationToken),
            await postgres.OwnerAccounts.CountAsync(cancellationToken));
    }

    private static async Task<List<Salon>> ReadSalons(SqliteConnection db, CancellationToken token)
    {
        var result = new List<Salon>();
        await using var command = db.CreateCommand();
        command.CommandText = "SELECT id,name,agent_id,timezone,services_json,barbers_json,knowledge_notes,created_at,webhook_secret_hash,webhook_secret_id,schedule_json,integration_ready FROM salons ORDER BY id";
        await using var reader = await command.ExecuteReaderAsync(token);
        while (await reader.ReadAsync(token)) result.Add(new Salon(reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.GetString(4), reader.GetString(5), reader.GetString(6), DateTime.Parse(reader.GetString(7), CultureInfo.InvariantCulture).ToUniversalTime(), reader.IsDBNull(8) ? null : reader.GetString(8), reader.IsDBNull(9) ? null : reader.GetString(9), reader.GetString(10), reader.GetInt64(11) == 1));
        return result;
    }

    private static async Task<List<SourceAppointment>> ReadSourceAppointments(SqliteConnection db, CancellationToken token)
    {
        var result = new List<SourceAppointment>();
        await using var command = db.CreateCommand();
        command.CommandText = "SELECT id,status,salon_id,date,time,service,barber,customer_name,phone,created_at,cancelled_at,cancelled_by FROM appointments ORDER BY id";
        await using var reader = await command.ExecuteReaderAsync(token);
        while (await reader.ReadAsync(token)) result.Add(new SourceAppointment(reader.GetString(0), reader.GetString(1), reader.GetString(2), DateOnly.Parse(reader.GetString(3), CultureInfo.InvariantCulture), TimeOnly.Parse(reader.GetString(4), CultureInfo.InvariantCulture), reader.GetString(5), reader.GetString(6), reader.GetString(7), reader.GetString(8), DateTime.Parse(reader.GetString(9), CultureInfo.InvariantCulture).ToUniversalTime(), reader.IsDBNull(10) ? null : DateTime.Parse(reader.GetString(10), CultureInfo.InvariantCulture).ToUniversalTime(), reader.IsDBNull(11) ? null : reader.GetString(11)));
        return result;
    }

    private static async Task<List<OwnerAccount>> ReadOwners(SqliteConnection db, CancellationToken token)
    {
        var result = new List<OwnerAccount>();
        await using var command = db.CreateCommand();
        command.CommandText = "SELECT username,salon_id,password_salt,password_hash,created_at FROM owner_accounts ORDER BY username";
        await using var reader = await command.ExecuteReaderAsync(token);
        while (await reader.ReadAsync(token)) result.Add(new OwnerAccount(reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3), DateTime.Parse(reader.GetString(4), CultureInfo.InvariantCulture).ToUniversalTime()));
        return result;
    }

    private static IEnumerable<string> ReadNames(string json)
        => (JsonSerializer.Deserialize<string[]>(json) ?? []).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()).Distinct(StringComparer.OrdinalIgnoreCase);

    private static T? Resolve<T>(Dictionary<(string SalonId, string Name), T> map, string salonId, string name) where T : class
        => map.FirstOrDefault(x => x.Key.SalonId == salonId && string.Equals(x.Key.Name, name, StringComparison.OrdinalIgnoreCase)).Value;

    private static string StableId(string salonId, string kind, string name) => $"{salonId}:{kind}:{Slug(name)}";

    private static string Slug(string value)
    {
        var normalized = value.Replace('đ', 'd').Replace('Đ', 'D').Normalize(NormalizationForm.FormD);
        var builder = new StringBuilder();
        foreach (var c in normalized)
            if (char.GetUnicodeCategory(c) != System.Globalization.UnicodeCategory.NonSpacingMark)
                builder.Append(char.IsLetterOrDigit(c) ? char.ToLowerInvariant(c) : '-');
        return builder.ToString().Trim('-');
    }

    private static bool EquivalentIdentity(Salon left, Salon right) => left.AgentId == right.AgentId && left.BarbersJson == right.BarbersJson && left.ScheduleJson == right.ScheduleJson && left.WebhookSecretId == right.WebhookSecretId;

    private sealed record SourceAppointment(string Id, string Status, string SalonId, DateOnly Date, TimeOnly Time, string Service, string Barber, string CustomerName, string Phone, DateTime CreatedAt, DateTime? CancelledAt, string? CancelledBy);
}

public sealed record MigrationSummary(int SourceSalons, int SourceWorkers, int SourceServices, int SourceAppointments, int SourceOwners,
    int TargetSalons, int TargetWorkers, int TargetServices, int TargetAppointments, int TargetOwners);
