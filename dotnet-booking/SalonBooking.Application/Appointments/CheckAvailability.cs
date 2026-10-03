using MediatR;
using Microsoft.EntityFrameworkCore;
using SalonBooking.Application.Common;
using SalonBooking.Domain.Booking;

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

        var services = await db.Services.AsNoTracking()
            .Where(x => x.SalonId == salon.Id && x.Active).ToListAsync(cancellationToken);
        var staff = await db.Workers.AsNoTracking()
            .Where(x => x.SalonId == salon.Id && x.Active).OrderBy(x => x.Name).ToListAsync(cancellationToken);
        var service = services.FirstOrDefault(x => string.Equals(x.Name, request.Service.Trim(), StringComparison.OrdinalIgnoreCase));
        if (service is null)
            return Fail("UNKNOWN_SERVICE", "Ta usluga nije dostupna u ovom salonu.", request, staff.Select(x => x.Name).ToList(), null);

        if (request.Barber is null || string.IsNullOrWhiteSpace(request.Barber))
            return new(true, "NEED_STAFF", "Koji zaposleni vam odgovara?", salon.Id, request.Date, service.Name, null,
                request.Time, null, [], staff.Select(x => x.Name).ToList(), null);

        var worker = staff.FirstOrDefault(x => string.Equals(x.Name, request.Barber.Trim(), StringComparison.OrdinalIgnoreCase));
        if (worker is null)
            return new(false, "UNKNOWN_STAFF", "Taj zaposleni ne radi u ovom salonu.", salon.Id, request.Date, service.Name,
                request.Barber, request.Time, null, [], staff.Select(x => x.Name).ToList(), null);

        var window = BookingPolicy.ReadSchedule(salon, worker.Name);
        var working = new Dictionary<string, string> { ["start"] = window.Start, ["end"] = window.End };
        if (request.Date < DateOnly.FromDateTime(DateTime.UtcNow))
            return new(false, "PAST_DATE", "Ne zakazujemo termine u prošlosti.", salon.Id, request.Date, service.Name, worker.Name,
                request.Time, false, [], staff.Select(x => x.Name).ToList(), working);

        var appointments = await db.Appointments.AsNoTracking()
            .Include(x => x.Service)
            .Where(x => x.SalonId == salon.Id && x.Status == "confirmed" && x.Date == request.Date && x.WorkerId == worker.Id)
            .ToListAsync(cancellationToken);
        var slots = new List<string>();
        if (!TimeOnly.TryParseExact(window.Start, "HH:mm", out var start) || !TimeOnly.TryParseExact(window.End, "HH:mm", out var close))
            return new(false, "INVALID_SCHEDULE", "Radno vreme salona nije ispravno podešeno.", salon.Id, request.Date, service.Name,
                worker.Name, request.Time, null, [], staff.Select(x => x.Name).ToList(), working);

        for (var t = start; t.AddMinutes(service.DurationMinutes) <= close; t = t.AddMinutes(30))
        {
            var decision = BookingPolicy.CheckSlot(t.ToString("HH:mm"), service.DurationMinutes, request.Date, worker.Name, salon);
            if (decision.Code == "AVAILABLE" && !appointments.Any(x => Overlaps(x.Time, x.Service.DurationMinutes, t, service.DurationMinutes)))
                slots.Add(t.ToString("HH:mm"));
        }

        if (string.IsNullOrWhiteSpace(request.Time))
            return new(true, null, null, salon.Id, request.Date, service.Name, worker.Name, null, null, slots,
                staff.Select(x => x.Name).ToList(), working);
        if (!TimeOnly.TryParseExact(request.Time, "HH:mm", out var requestedTime))
            return new(true, "INVALID_TIME", "Vreme mora biti u formatu HH:MM, na primer 10:30.", salon.Id, request.Date,
                service.Name, worker.Name, request.Time, false, slots, staff.Select(x => x.Name).ToList(), working);

        var requestedDecision = BookingPolicy.CheckSlot(requestedTime.ToString("HH:mm"), service.DurationMinutes, request.Date, worker.Name, salon);
        if (requestedDecision.Code != "AVAILABLE")
            return new(true, requestedDecision.Code, requestedDecision.Reason, salon.Id, request.Date, service.Name, worker.Name,
                request.Time, false, slots, staff.Select(x => x.Name).ToList(), working);
        var taken = appointments.Any(x => Overlaps(x.Time, x.Service.DurationMinutes, requestedTime, service.DurationMinutes));
        return new(true, taken ? "SLOT_TAKEN" : "AVAILABLE", taken ? "Taj termin je već zauzet." : "Traženi termin je slobodan.",
            salon.Id, request.Date, service.Name, worker.Name, request.Time, !taken, slots, staff.Select(x => x.Name).ToList(), working);
    }

    private static CheckAvailabilityResponse Fail(string code, string reason, CheckAvailabilityQuery request, IReadOnlyList<string> staff,
        IReadOnlyDictionary<string, string>? working)
        => new(false, code, reason, request.SalonId, request.Date, request.Service, request.Barber, request.Time, null, [], staff, working);

    private static bool Overlaps(TimeOnly existingStart, int existingDuration, TimeOnly requestedStart, int requestedDuration)
        => requestedStart < existingStart.AddMinutes(existingDuration) && existingStart < requestedStart.AddMinutes(requestedDuration);
}
