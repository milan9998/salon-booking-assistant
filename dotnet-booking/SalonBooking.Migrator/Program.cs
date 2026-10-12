using Microsoft.EntityFrameworkCore;
using SalonBooking.Infrastructure.Persistence;

var sqlite = args.Length > 0 ? args[0] : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../appointments.db"));
var connection = Environment.GetEnvironmentVariable("POSTGRES_CONNECTION_STRING");
if (string.IsNullOrWhiteSpace(connection))
{
    Console.Error.WriteLine("POSTGRES_CONNECTION_STRING nije podešen. Import nije pokrenut.");
    return 2;
}
if (!File.Exists(sqlite))
{
    Console.Error.WriteLine($"SQLite kopija ne postoji: {sqlite}");
    return 2;
}
var options = new DbContextOptionsBuilder<BookingDbContext>().UseNpgsql(connection).Options;
await using var db = new BookingDbContext(options);
var summary = await new SqliteDataImporter(db).ImportAsync(sqlite);
Console.WriteLine($"Migracija završena: izvor saloni={summary.SourceSalons}, radnici={summary.SourceWorkers}, usluge={summary.SourceServices}, termini={summary.SourceAppointments}, vlasnici={summary.SourceOwners}; PostgreSQL ukupno saloni={summary.TargetSalons}, radnici={summary.TargetWorkers}, usluge={summary.TargetServices}, termini={summary.TargetAppointments}, vlasnici={summary.TargetOwners}.");
if (!HasMatchingRecordCounts(summary))
{
    Console.Error.WriteLine("PROVERA NIJE PROŠLA: broj zapisa se ne poklapa.");
    return 1;
}
return 0;

static bool HasMatchingRecordCounts(MigrationSummary summary)
    => summary.SourceSalons == summary.TargetSalons && summary.SourceWorkers == summary.TargetWorkers
        && summary.SourceServices == summary.TargetServices && summary.SourceAppointments == summary.TargetAppointments
        && summary.SourceOwners == summary.TargetOwners;
