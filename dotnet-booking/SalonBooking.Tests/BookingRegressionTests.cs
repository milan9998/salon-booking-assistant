using System.Text.Json;
using MediatR;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using SalonBooking.Api;
using SalonBooking.Api.Controllers;
using SalonBooking.Application;
using SalonBooking.Application.Appointments;
using SalonBooking.Application.Common;
using SalonBooking.Domain.Booking;
using SalonBooking.Domain.Entities;
using SalonBooking.Infrastructure.Persistence;
using Xunit;
using TestDatabase = SalonBooking.Tests.BookingConcurrencyTests.TestDatabase;

namespace SalonBooking.Tests;

public sealed class BookingRegressionTests
{
    [Theory]
    [InlineData("063 111-1111", "0631111111")]
    [InlineData("+381 63 111 1111", "0631111111")]
    [InlineData("00381 63 111 1111", "0631111111")]
    public void Local_and_international_phone_formats_share_one_identity(string input, string expected)
        => Assert.Equal(expected, CustomerPhone.Normalize(input));

    [Fact]
    public void Past_time_and_dates_use_the_salons_timezone()
    {
        var salon = Salon();
        var now = new DateTimeOffset(2026, 10, 16, 12, 0, 0, TimeSpan.Zero);
        Assert.Equal("PAST_TIME", BookingPolicy.CheckSlot("13:00", 30, new(2026, 10, 16), "Marko", salon, now: now).Code);
        Assert.Equal("PAST_DATE", BookingPolicy.CheckSlot("16:00", 30, new(2026, 10, 16), "Marko", salon,
            now: new DateTimeOffset(2026, 10, 16, 23, 0, 0, TimeSpan.Zero)).Code);
    }

    [Fact]
    public void A_service_cannot_wrap_past_midnight_or_generate_endless_slots()
    {
        var salon = Salon("{\"weekdays\":[1,2,3,4,5,6],\"start\":\"09:00\",\"end\":\"23:59\"}");
        Assert.Equal("OUTSIDE_HOURS", BookingPolicy.CheckSlot("23:30", 90, new(2031, 4, 15), "Marko", salon).Code);
        var worker = new Worker("w", salon.Id, "Marko");
        var service = new SalonService("s", salon.Id, "farbanje", 90, true);
        var slots = AppointmentSlots.Available(new(2031, 4, 15), salon, worker, service, []);
        Assert.Equal("22:00", slots.Last());
        Assert.DoesNotContain("23:30", slots);
    }

    [Fact]
    public void Invalid_schedule_windows_and_breaks_are_rejected()
    {
        using var valid = JsonDocument.Parse("{\"weekdays\":[1],\"start\":\"09:00\",\"end\":\"17:00\",\"breaks\":[]}");
        using var invalid = JsonDocument.Parse("{\"weekdays\":[1],\"start\":\"17:00\",\"end\":\"09:00\"}");
        using var invalidBreak = JsonDocument.Parse("{\"weekdays\":[1],\"start\":\"09:00\",\"end\":\"17:00\",\"breaks\":[{\"start\":\"08:00\",\"end\":\"10:00\"}]}");
        Assert.True(ScheduleValidation.IsValid(valid.RootElement, ["Marko"]));
        Assert.False(ScheduleValidation.IsValid(invalid.RootElement, ["Marko"]));
        Assert.False(ScheduleValidation.IsValid(invalidBreak.RootElement, ["Marko"]));
    }

    [Fact]
    public void Working_hours_starting_between_slots_use_the_next_half_hour()
    {
        var salon = Salon("{\"weekdays\":[1,2,3,4,5,6],\"start\":\"09:15\",\"end\":\"10:15\"}");
        var slots = AppointmentSlots.Available(new(2031, 4, 15), salon,
            new Worker("w", salon.Id, "Marko"), new SalonService("s", salon.Id, "sisanje", 30, true), []);
        Assert.Equal(new[] { "09:30" }, slots);
    }

    [PostgreSqlFact]
    public async Task Availability_API_checks_phone_and_returns_an_eligible_unoccupied_alternative()
    {
        await using var database = await TestDatabase.CreateAsync();
        await Seed(database, new(2027, 3, 15), "0631111111");
        await Seed(database, new(2027, 3, 22), "0632222222", new(9, 0));
        await using var db = database.CreateContext();
        using var services = Services(db);
        var controller = BookingController(services, db);
        var request = JsonSerializer.Deserialize<AvailabilityRequest>(
            "{\"salon_id\":\"test-salon\",\"date\":\"2027-03-16\",\"service\":\"sisanje\",\"barber\":\"Marko\",\"time\":\"10:00\",\"phone\":\"+381631111111\"}",
            new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower })!;
        var result = Assert.IsType<CheckAvailabilityResponse>(Assert.IsType<OkObjectResult>(await controller.CheckAvailability(request, default)).Value);
        Assert.Equal("CUSTOMER_WEEKLY_LIMIT", result.Code);
        Assert.False(result.RequestedTimeAvailable);
        Assert.Equal(new DateOnly(2027, 3, 22), result.NextEligibleDate);
        Assert.Equal(new NextBookingSlot(new(2027, 3, 22), "09:30", "Marko"), result.NextAvailableSlot);
        var allowed = await services.GetRequiredService<IMediator>().Send(new CheckAvailabilityQuery("test-salon", new(2027, 3, 22), "sisanje", "Marko", "09:30", "0631111111"));
        Assert.Equal("AVAILABLE", allowed.Code);
        Assert.True(allowed.RequestedTimeAvailable);
    }

    [PostgreSqlFact]
    public async Task Alternatives_skip_other_future_bookings_for_the_same_phone()
    {
        await using var database = await TestDatabase.CreateAsync();
        await Seed(database, new(2027, 3, 15), "0631111111");
        await Seed(database, new(2027, 3, 25), "0631111111");
        await using var db = database.CreateContext();
        using var services = Services(db);
        var result = await services.GetRequiredService<IMediator>().Send(new CheckAvailabilityQuery("test-salon", new(2027, 3, 16), "sisanje", "Marko", "10:00", "0631111111"));
        Assert.Equal(new DateOnly(2027, 4, 1), result.NextEligibleDate);
        Assert.Equal(new DateOnly(2027, 4, 1), result.NextAvailableSlot!.Date);
    }

    [PostgreSqlFact]
    public async Task Cancellation_limit_is_a_readable_200_business_result_and_keeps_the_booking()
    {
        await using var database = await TestDatabase.CreateAsync();
        var id = await Seed(database, new(2027, 3, 15), "0631111111");
        await Seed(database, new(2027, 3, 8), "0631111111", cancelled: true);
        await using var db = database.CreateContext();
        using var services = Services(db);
        var controller = BookingController(services, db);
        var response = Assert.IsType<OkObjectResult>(await controller.Cancel(new("test-salon", "Wrong name", "2027-03-15", "10:00", "0631111111"), default));
        Assert.Equal(200, response.StatusCode);
        Assert.Equal("CUSTOMER_WEEKLY_CANCEL_LIMIT", Assert.IsType<CancelAppointmentResponse>(response.Value).Code);
        Assert.Equal("confirmed", (await db.Appointments.SingleAsync(x => x.Id == id)).Status);
    }

    [PostgreSqlFact]
    public async Task Cancellation_ignores_name_normalizes_phone_and_distinguishes_invalid_phone_from_missing_booking()
    {
        await using var database = await TestDatabase.CreateAsync();
        await Seed(database, new(2027, 3, 15), "0631111111");
        await using var db = database.CreateContext();
        using var services = Services(db);
        var c = BookingController(services, db);
        var invalid = Assert.IsType<CancelAppointmentResponse>(Assert.IsType<OkObjectResult>(await c.Cancel(new("test-salon", null, "2027-03-15", "10:00", "123"), default)).Value);
        Assert.Equal("INVALID_PHONE", invalid.Code);
        var missing = Assert.IsType<CancelAppointmentResponse>(Assert.IsType<OkObjectResult>(await c.Cancel(new("test-salon", null, "2027-03-16", "10:00", "0631111111"), default)).Value);
        Assert.Equal("APPOINTMENT_NOT_FOUND", missing.Code);
        var cancelled = Assert.IsType<CancelAppointmentResponse>(Assert.IsType<OkObjectResult>(await c.Cancel(new("test-salon", "Miljan", "2027-03-15", "10:00", "+381631111111"), default)).Value);
        Assert.True(cancelled.Ok);
    }

    [PostgreSqlFact]
    public async Task Two_concurrent_cancellations_only_spend_one_weekly_cancellation()
    {
        await using var database = await TestDatabase.CreateAsync();
        await Seed(database, new(2027, 3, 15), "0631111111");
        await Seed(database, new(2027, 3, 22), "0631111111");
        async Task<CancelAppointmentResponse> Cancel(DateOnly date)
        {
            await using var db = database.CreateContext();
            return await new CancelAppointmentHandler(db, new BookingTransactionRunner(db))
                .Handle(new("test-salon", date, new(10, 0), "0631111111"), default);
        }
        var result = await Task.WhenAll(Cancel(new(2027, 3, 15)), Cancel(new(2027, 3, 22)));
        Assert.Single(result, x => x.Ok);
        Assert.Equal("CUSTOMER_WEEKLY_CANCEL_LIMIT", Assert.Single(result, x => !x.Ok).Code);
    }

    [PostgreSqlFact]
    public async Task Owner_can_cancel_after_customer_limit_and_other_salons_are_inaccessible()
    {
        await using var database = await TestDatabase.CreateAsync();
        var id = await Seed(database, new(2027, 3, 15), "0631111111");
        await Seed(database, new(2027, 3, 8), "0631111111", cancelled: true);
        await using var db = database.CreateContext();
        using var services = Services(db);
        var controller = new AdminController(db, services.GetRequiredService<IMediator>(), new BookingTransactionRunner(db))
            { ControllerContext = Context(new("owner", "owner-other", "other-salon")) };
        Assert.Equal(403, Assert.IsType<ObjectResult>(await controller.OwnerCancel(new(id), default)).StatusCode);
        controller.ControllerContext = Context(new("owner", "owner", "test-salon"));
        Assert.IsType<OkObjectResult>(await controller.OwnerCancel(new(id), default));
        Assert.Equal("owner", (await db.Appointments.SingleAsync(x => x.Id == id)).CancelledBy);
        var booking = BookingController(services, db, new("owner", "owner-other", "other-salon"));
        Assert.IsType<UnauthorizedObjectResult>(await booking.Appointments("test-salon", default));
        var list = Assert.IsType<OkObjectResult>(await booking.Salons(default));
        Assert.DoesNotContain("Test salon", JsonSerializer.Serialize(list.Value));
        booking.ControllerContext = new() { HttpContext = new DefaultHttpContext() };
        Assert.IsType<UnauthorizedObjectResult>(await booking.Salons(default));
        var integrations = new AgentIntegrationController(db, new UnusedProvisioner())
            { ControllerContext = Context(new("owner", "owner", "test-salon")) };
        Assert.IsType<UnauthorizedObjectResult>(await integrations.Integrations(default));
        integrations.ControllerContext = Context(new("platform", "admin", null));
        var inventory = JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(await integrations.Integrations(default)).Value);
        Assert.DoesNotContain("WebhookSecretHash", inventory);
        Assert.Contains("Test salon", inventory);
    }

    private sealed class UnusedProvisioner : IAgentProvisioner
    {
        public Task ProvisionAsync(string salonId, CancellationToken cancellationToken)
            => throw new InvalidOperationException("Read-only inventory must not provision an agent.");
    }

    private static ServiceProvider Services(BookingDbContext db)
    {
        var services = new ServiceCollection();
        services.AddSingleton<IBookingDbContext>(db);
        services.AddSingleton<IBookingTransactionRunner>(new BookingTransactionRunner(db));
        services.AddApplication();
        services.AddMediatR(typeof(BookAppointmentHandler).Assembly);
        return services.BuildServiceProvider();
    }

    private static BookingController BookingController(IServiceProvider services, BookingDbContext db, ApiIdentity? identity = null)
        => new(services.GetRequiredService<IMediator>(), db) { ControllerContext = Context(identity ?? new("platform", "admin", null)) };

    private static ControllerContext Context(ApiIdentity identity)
    {
        var context = new DefaultHttpContext();
        context.Request.Headers.Authorization = "Bearer " + SessionStore.Issue(identity);
        return new() { HttpContext = context };
    }

    private static async Task<string> Seed(TestDatabase database, DateOnly date, string phone, TimeOnly? time = null, bool cancelled = false)
    {
        await using var db = database.CreateContext();
        var id = "test-" + Guid.NewGuid().ToString("N");
        var appointment = new Appointment(id, "confirmed", "test-salon", "worker-marko", "service-sisanje", date, time ?? new(10, 0), "Milan", phone, DateTime.UtcNow, null, null);
        if (cancelled) appointment.Cancel("customer", DateTime.UtcNow);
        db.Appointments.Add(appointment);
        await db.SaveChangesAsync();
        return id;
    }

    private static Salon Salon(string schedule = "{}")
        => new("test-salon", "Test salon", "test-agent", "Europe/Belgrade", "[]", "[]", "", DateTime.UtcNow, null, null, schedule, true);
}
