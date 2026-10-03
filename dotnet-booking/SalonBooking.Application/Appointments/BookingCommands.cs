using MediatR;
using Microsoft.EntityFrameworkCore;
using SalonBooking.Application.Common;
using SalonBooking.Domain.Booking;
using SalonBooking.Domain.Entities;

namespace SalonBooking.Application.Appointments;

public sealed record BookAppointmentCommand(string SalonId, DateOnly Date, TimeOnly Time, string Service, string Barber, string CustomerName, string Phone) : IRequest<BookAppointmentResponse>;
public sealed record BookAppointmentResponse(bool Ok, string? Code, string Message, AppointmentDto? Appointment);

public sealed class BookAppointmentHandler(IBookingDbContext db) : IRequestHandler<BookAppointmentCommand, BookAppointmentResponse>
{
    public async Task<BookAppointmentResponse> Handle(BookAppointmentCommand request, CancellationToken cancellationToken)
    {
        var salon = await db.Salons.SingleOrDefaultAsync(x => x.Id == request.SalonId, cancellationToken);
        if (salon is null) return new(false, "SALON_NOT_FOUND", "Salon nije pronađen.", null);

        var services = await db.Services.Where(x => x.SalonId == salon.Id && x.Active).ToListAsync(cancellationToken);
        var workers = await db.Workers.Where(x => x.SalonId == salon.Id && x.Active).ToListAsync(cancellationToken);
        var service = services.FirstOrDefault(x => string.Equals(x.Name, request.Service.Trim(), StringComparison.OrdinalIgnoreCase));
        if (service is null) return new(false, "UNKNOWN_SERVICE", "Ta usluga nije dostupna u ovom salonu.", null);
        var worker = workers.FirstOrDefault(x => string.Equals(x.Name, request.Barber.Trim(), StringComparison.OrdinalIgnoreCase));
        if (worker is null) return new(false, "UNKNOWN_STAFF", "Taj zaposleni ne radi u ovom salonu.", null);

        var rule = BookingPolicy.CheckSlot(request.Time.ToString("HH:mm"), service.DurationMinutes, request.Date, worker.Name, salon);
        if (rule.Code != "AVAILABLE") return new(false, rule.Code, rule.Reason, null);
        var normalizedPhone = Digits(request.Phone);
        if (normalizedPhone.Length is < 9 or > 10 || !normalizedPhone.StartsWith("06", StringComparison.Ordinal))
            return new(false, "INVALID_PHONE", "Broj telefona mora biti srpski mobilni broj koji počinje sa 06.", null);

        var recent = await db.Appointments.AsNoTracking()
            .Where(x => x.SalonId == request.SalonId && x.Status == "confirmed")
            .ToListAsync(cancellationToken);
        if (recent.Any(x => Digits(x.Phone) == normalizedPhone && Math.Abs(x.Date.DayNumber - request.Date.DayNumber) < 7))
            return new(false, "CUSTOMER_WEEKLY_LIMIT", "Za ovaj broj telefona već postoji rezervacija u periodu od sedam dana.", null);

        var sameDay = await db.Appointments.AsNoTracking().Include(x => x.Service)
            .Where(x => x.SalonId == request.SalonId && x.Status == "confirmed" && x.Date == request.Date && x.WorkerId == worker.Id)
            .ToListAsync(cancellationToken);
        if (sameDay.Any(x => Overlaps(x.Time, x.Service.DurationMinutes, request.Time, service.DurationMinutes)))
            return new(false, "SLOT_TAKEN", "Termin je u međuvremenu zauzet.", null);

        var appointment = new Appointment($"BR-{Guid.NewGuid().ToString("N")[..6].ToUpperInvariant()}", "confirmed", request.SalonId,
            worker.Id, service.Id, request.Date, request.Time, request.CustomerName.Trim(), request.Phone.Trim(), DateTime.UtcNow, null, null);
        db.Appointments.Add(appointment);
        await db.SaveChangesAsync(cancellationToken);
        return new(true, null, "Termin je zakazan.", ToDto(appointment, worker, service));
    }

    private static bool Overlaps(TimeOnly existingStart, int existingDuration, TimeOnly requestedStart, int requestedDuration)
        => requestedStart < existingStart.AddMinutes(existingDuration) && existingStart < requestedStart.AddMinutes(requestedDuration);

    public static string Digits(string value) => new(value.Where(char.IsDigit).ToArray());
    public static AppointmentDto ToDto(Appointment appointment, Worker worker, SalonService service)
        => new(appointment.Id, appointment.Status, appointment.SalonId, appointment.Date, appointment.Time, service.Name, worker.Name,
            appointment.CustomerName, appointment.Phone, appointment.CreatedAt, appointment.CancelledAt, appointment.CancelledBy,
            worker.Id, service.Id);
}

public sealed record CancelAppointmentCommand(string SalonId, DateOnly Date, TimeOnly Time, string Phone) : IRequest<CancelAppointmentResponse>;
public sealed record CancelAppointmentResponse(bool Ok, string? Code, string Message, AppointmentDto? Appointment);

public sealed class CancelAppointmentHandler(IBookingDbContext db) : IRequestHandler<CancelAppointmentCommand, CancelAppointmentResponse>
{
    public async Task<CancelAppointmentResponse> Handle(CancelAppointmentCommand request, CancellationToken cancellationToken)
    {
        var phone = BookAppointmentHandler.Digits(request.Phone);
        var matches = await db.Appointments.Include(x => x.Worker).Include(x => x.Service)
            .Where(x => x.SalonId == request.SalonId && x.Status == "confirmed" && x.Date == request.Date && x.Time == request.Time)
            .ToListAsync(cancellationToken);
        var phoneMatches = matches.Where(x => BookAppointmentHandler.Digits(x.Phone) == phone).ToList();
        if (phoneMatches.Count > 1) return new(false, "APPOINTMENT_AMBIGUOUS", "Više termina se poklapa sa datumom, vremenom i brojem telefona; vlasnik treba da proveri koji termin otkazuje.", null);
        var appointment = phoneMatches.SingleOrDefault();
        if (appointment is null) return new(false, "APPOINTMENT_NOT_FOUND", "Potvrđen termin nije pronađen.", null);
        if (phone.Length is < 9 or > 10 || !phone.StartsWith("06", StringComparison.Ordinal))
            return new(false, "INVALID_PHONE", "Broj telefona mora biti srpski mobilni broj koji počinje sa 06.", null);
        var recentCancellation = await db.Appointments.AsNoTracking()
            .Where(x => x.SalonId == request.SalonId && x.Status == "cancelled" && x.CancelledBy == "customer" && x.CancelledAt != null)
            .ToListAsync(cancellationToken);
        if (recentCancellation.Any(x => BookAppointmentHandler.Digits(x.Phone) == phone && DateTime.UtcNow - x.CancelledAt!.Value < TimeSpan.FromDays(7)))
            return new(false, "CUSTOMER_WEEKLY_CANCEL_LIMIT", "Već ste jednom otkazali termin u poslednjih sedam dana. Za novo otkazivanje kontaktirajte salon.", null);
        appointment.Cancel("customer", DateTime.UtcNow);
        await db.SaveChangesAsync(cancellationToken);
        return new(true, null, "Termin je otkazan.", BookAppointmentHandler.ToDto(appointment, appointment.Worker, appointment.Service));
    }

}
