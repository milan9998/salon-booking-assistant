using Microsoft.EntityFrameworkCore;
using Npgsql;
using SalonBooking.Application.Appointments;
using SalonBooking.Infrastructure.Persistence;
using Xunit;

namespace SalonBooking.Tests;

public sealed class BookingConcurrencyTests
{
    [PostgreSqlFact]
    public async Task Simultaneous_requests_for_same_worker_and_time_only_create_one_booking()
    {
        await using var database = await TestDatabase.CreateAsync();
        var date = new DateOnly(2027, 3, 15);

        var responses = await Task.WhenAll(
            database.BookAsync(date, new TimeOnly(10, 0), "worker-marko", "Milan", "0631111111"),
            database.BookAsync(date, new TimeOnly(10, 0), "worker-marko", "Petar", "0632222222"));

        Assert.Single(responses, x => x.Ok);
        Assert.Equal("SLOT_TAKEN", Assert.Single(responses, x => !x.Ok).Code);
        Assert.Equal(1, await database.CountConfirmedAsync());
    }

    [PostgreSqlFact]
    public async Task Simultaneous_bookings_for_same_normalized_phone_only_allow_one_within_seven_days()
    {
        await using var database = await TestDatabase.CreateAsync();
        var date = new DateOnly(2027, 3, 15);

        var responses = await Task.WhenAll(
            database.BookAsync(date, new TimeOnly(10, 0), "worker-marko", "Milan", "063 444 5555"),
            database.BookAsync(date.AddDays(1), new TimeOnly(11, 0), "worker-nikola", "Milan", "063-444-5555"));

        Assert.Single(responses, x => x.Ok);
        Assert.Equal("CUSTOMER_WEEKLY_LIMIT", Assert.Single(responses, x => !x.Ok).Code);
        Assert.Equal(1, await database.CountConfirmedAsync());
    }

    internal sealed class TestDatabase(string adminConnectionString, string connectionString, string databaseName) : IAsyncDisposable
    {
        private readonly DbContextOptions<BookingDbContext> _options = new DbContextOptionsBuilder<BookingDbContext>()
            .UseNpgsql(connectionString)
            .Options;

        public static async Task<TestDatabase> CreateAsync()
        {
            var baseConnection = Environment.GetEnvironmentVariable("POSTGRES_TEST_CONNECTION_STRING")!;
            var databaseName = $"booking_test_{Guid.NewGuid():N}";
            var admin = new NpgsqlConnectionStringBuilder(baseConnection) { Database = "postgres", Pooling = false };
            try
            {
                await using (var connection = new NpgsqlConnection(admin.ConnectionString))
                {
                    await connection.OpenAsync();
                    await using var createDatabase = connection.CreateCommand();
                    createDatabase.CommandText = $"CREATE DATABASE \"{databaseName}\"";
                    await createDatabase.ExecuteNonQueryAsync();
                }

                var scoped = new NpgsqlConnectionStringBuilder(baseConnection) { Database = databaseName, Pooling = false };
                var database = new TestDatabase(admin.ConnectionString, scoped.ConnectionString, databaseName);
                await using var db = database.CreateContext();
                await db.Database.EnsureCreatedAsync();
                db.Salons.Add(new("test-salon", "Test salon", "test-agent", "Europe/Belgrade", "[\"sisanje\"]", "[\"Marko\",\"Nikola\"]", "", DateTime.UtcNow, null, null, "{}", true));
                db.Workers.AddRange(
                    new("worker-marko", "test-salon", "Marko"),
                    new("worker-nikola", "test-salon", "Nikola"));
                db.Services.Add(new("service-sisanje", "test-salon", "sisanje", 30, true));
                await db.SaveChangesAsync();
                return database;
            }
            catch
            {
                await DropDatabaseAsync(admin.ConnectionString, databaseName);
                throw;
            }
        }

        public async Task<BookAppointmentResponse> BookAsync(DateOnly date, TimeOnly time, string workerId, string name, string phone)
        {
            await using var db = CreateContext();
            var handler = new BookAppointmentHandler(db, new BookingTransactionRunner(db), new BookingEligibilityService(db));
            var barber = workerId == "worker-marko" ? "Marko" : "Nikola";
            return await handler.Handle(new("test-salon", date, time, "sisanje", barber, name, phone), CancellationToken.None);
        }

        public async Task<int> CountConfirmedAsync()
        {
            await using var db = CreateContext();
            return await db.Appointments.CountAsync(x => x.Status == "confirmed");
        }

        public BookingDbContext CreateContext() => new(_options);

        public ValueTask DisposeAsync() => DropDatabaseAsync(adminConnectionString, databaseName);

        private static async ValueTask DropDatabaseAsync(string adminConnectionString, string databaseName)
        {
            await using var connection = new NpgsqlConnection(adminConnectionString);
            await connection.OpenAsync();
            await using var terminate = connection.CreateCommand();
            terminate.CommandText = "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = @database AND pid <> pg_backend_pid()";
            terminate.Parameters.AddWithValue("database", databaseName);
            await terminate.ExecuteNonQueryAsync();
            await using var dropDatabase = connection.CreateCommand();
            dropDatabase.CommandText = $"DROP DATABASE IF EXISTS \"{databaseName}\"";
            await dropDatabase.ExecuteNonQueryAsync();
        }
    }
}

public sealed class PostgreSqlFactAttribute : FactAttribute
{
    public PostgreSqlFactAttribute()
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("POSTGRES_TEST_CONNECTION_STRING")))
            Skip = "Set POSTGRES_TEST_CONNECTION_STRING to an isolated PostgreSQL test database to run this integration test.";
    }
}
