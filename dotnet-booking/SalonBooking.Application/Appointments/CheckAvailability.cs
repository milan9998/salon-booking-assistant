using MediatR;
using Microsoft.EntityFrameworkCore;
using SalonBooking.Application.Common;
using SalonBooking.Domain.Booking;
using SalonBooking.Domain.Entities;

namespace SalonBooking.Application.Appointments;

public sealed record CheckAvailabilityQuery(string SalonId, DateOnly Date, string Service, string? Barber, string? Time) : IRequest<CheckAvailabilityResponse>;
public sealed record CheckAvailabilityResponse(bool Ok, string? Code, string? Reason, string SalonId, DateOnly Date, string Service,
    string? Barber, string? RequestedTime, bool? RequestedTimeAvailable, IReadOnlyList<string> AvailableSlots,
    IReadOnlyList<string> AvailableStaff, IReadOnlyDictionary<string, string>? WorkingHours);

public sealed class CheckAvailabilityHandler(IBookingDbContext db) : IRequestHandler<CheckAvailabilityQuery, CheckAvailabilityResponse>
{
    public async Task<CheckAvailabilityResponse> Handle(CheckAvailabilityQuery request, CancellationToken cancellationToken)
    {
        var salon = await db.Salons.AsNoTracking().SingleOrDefaultAsync(x => x.Id == request.SalonId, cancellationToken);
        if (salon is null)
            return Fail("SALON_NOT_FOUND", "Salon nije pronađen.", request, [], null);

        var service = await FindActiveServiceAsync(salon.Id, request.Service, cancellationToken);
        var staff = await GetActiveWorkersAsync(salon.Id, cancellationToken);
        var staffNames = staff.Select(x => x.Name).ToList();
        if (service is null)
            return Fail("UNKNOWN_SERVICE", "Ta usluga nije dostupna u ovom salonu.", request, staffNames, null);

        if (request.Barber is null || string.IsNullOrWhiteSpace(request.Barber))
            return new(true, "NEED_STAFF", "Koji zaposleni vam odgovara?", salon.Id, request.Date, service.Name, null,
                request.Time, null, [], staffNames, null);

        var worker = staff.FirstOrDefault(x => string.Equals(x.Name, request.Barber.Trim(), StringComparison.OrdinalIgnoreCase));
        if (worker is null)
            return new(false, "UNKNOWN_STAFF", "Taj zaposleni ne radi u ovom salonu.", salon.Id, request.Date, service.Name,
                request.Barber, request.Time, null, [], staffNames, null);

        return await GetWorkerAvailabilityAsync(request, salon, service, worker, staffNames, cancellationToken);
    }

    private async Task<SalonService?> FindActiveServiceAsync(string salonId, string serviceName, CancellationToken cancellationToken)
    {
        var services = await db.Services.AsNoTracking()
            .Where(x => x.SalonId == salonId && x.Active).ToListAsync(cancellationToken);
        return services.FirstOrDefault(x => string.Equals(x.Name, serviceName.Trim(), StringComparison.OrdinalIgnoreCase));
    }

    private async Task<List<Worker>> GetActiveWorkersAsync(string salonId, CancellationToken cancellationToken)
        => await db.Workers.AsNoTracking()
            .Where(x => x.SalonId == salonId && x.Active).OrderBy(x => x.Name).ToListAsync(cancellationToken);

    private async Task<CheckAvailabilityResponse> GetWorkerAvailabilityAsync(
        CheckAvailabilityQuery request, Salon salon, SalonService service, Worker worker,
        IReadOnlyList<string> staffNames, CancellationToken cancellationToken)
    {
        var window = BookingPolicy.ReadSchedule(salon, worker.Name);
        var working = new Dictionary<string, string> { ["start"] = window.Start, ["end"] = window.End };
        var response = new CheckAvailabilityResponse(true, null, null, salon.Id, request.Date, service.Name, worker.Name,
            request.Time, null, [], staffNames, working);
        if (request.Date < DateOnly.FromDateTime(DateTime.UtcNow))
            return response with { Ok = false, Code = "PAST_DATE", Reason = "Ne zakazujemo termine u prošlosti.", RequestedTimeAvailable = false };

        var appointments = await GetConfirmedWorkerAppointmentsAsync(salon.Id, worker.Id, request.Date, cancellationToken);
        if (!TimeOnly.TryParseExact(window.Start, "HH:mm", out var start) || !TimeOnly.TryParseExact(window.End, "HH:mm", out var close))
            return response with { Ok = false, Code = "INVALID_SCHEDULE", Reason = "Radno vreme salona nije ispravno podešeno." };

        var slots = BuildAvailableSlots(request.Date, salon, worker, service, appointments, start, close);
        return CheckRequestedTime(request, salon, worker, service, appointments, response with { AvailableSlots = slots });
    }

    private async Task<List<Appointment>> GetConfirmedWorkerAppointmentsAsync(
        string salonId, string workerId, DateOnly date, CancellationToken cancellationToken)
        => await db.Appointments.AsNoTracking()
            .Include(x => x.Service)
            .Where(x => x.SalonId == salonId && x.Status == "confirmed" && x.Date == date && x.WorkerId == workerId)
            .ToListAsync(cancellationToken);

    private static List<string> BuildAvailableSlots(DateOnly date, Salon salon, Worker worker, SalonService service,
        IReadOnlyList<Appointment> appointments, TimeOnly start, TimeOnly close)
    {
        var slots = new List<string>();
        for (var t = start; t.AddMinutes(service.DurationMinutes) <= close; t = t.AddMinutes(30))
        {
            var decision = BookingPolicy.CheckSlot(t.ToString("HH:mm"), service.DurationMinutes, date, worker.Name, salon);
            if (decision.Code == "AVAILABLE" && !appointments.Any(x => Overlaps(x.Time, x.Service.DurationMinutes, t, service.DurationMinutes)))
                slots.Add(t.ToString("HH:mm"));
        }
        return slots;
    }

    private static CheckAvailabilityResponse CheckRequestedTime(CheckAvailabilityQuery request, Salon salon, Worker worker,
        SalonService service, IReadOnlyList<Appointment> appointments, CheckAvailabilityResponse response)
    {
        if (string.IsNullOrWhiteSpace(request.Time))
            return response with { RequestedTime = null };
        if (!TimeOnly.TryParseExact(request.Time, "HH:mm", out var requestedTime))
            return response with { Code = "INVALID_TIME", Reason = "Vreme mora biti u formatu HH:MM, na primer 10:30.", RequestedTimeAvailable = false };

        var requestedDecision = BookingPolicy.CheckSlot(requestedTime.ToString("HH:mm"), service.DurationMinutes, request.Date, worker.Name, salon);
        if (requestedDecision.Code != "AVAILABLE")
            return response with { Code = requestedDecision.Code, Reason = requestedDecision.Reason, RequestedTimeAvailable = false };
        var taken = appointments.Any(x => Overlaps(x.Time, x.Service.DurationMinutes, requestedTime, service.DurationMinutes));
        return response with
        {
            Code = taken ? "SLOT_TAKEN" : "AVAILABLE",
            Reason = taken ? "Taj termin je već zauzet." : "Traženi termin je slobodan.",
            RequestedTimeAvailable = !taken
        };
    }

    private static CheckAvailabilityResponse Fail(string code, string reason, CheckAvailabilityQuery request, IReadOnlyList<string> staff,
        IReadOnlyDictionary<string, string>? working)
        => new(false, code, reason, request.SalonId, request.Date, request.Service, request.Barber, request.Time, null, [], staff, working);

    private static bool Overlaps(TimeOnly existingStart, int existingDuration, TimeOnly requestedStart, int requestedDuration)
        => requestedStart < existingStart.AddMinutes(existingDuration) && existingStart < requestedStart.AddMinutes(requestedDuration);
}
