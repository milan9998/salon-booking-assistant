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

        var service = await FindActiveServiceAsync(salon.Id, request.Service, cancellationToken);
        if (service is null) return new(false, "UNKNOWN_SERVICE", "Ta usluga nije dostupna u ovom salonu.", null);
        var worker = await FindActiveWorkerAsync(salon.Id, request.Barber, cancellationToken);
        if (worker is null) return new(false, "UNKNOWN_STAFF", "Taj zaposleni ne radi u ovom salonu.", null);

        var rule = BookingPolicy.CheckSlot(request.Time.ToString("HH:mm"), service.DurationMinutes, request.Date, worker.Name, salon);
        if (rule.Code != "AVAILABLE") return new(false, rule.Code, rule.Reason, null);
        var normalizedPhone = Digits(request.Phone);
        if (!IsValidSerbianMobilePhone(normalizedPhone))
            return new(false, "INVALID_PHONE", "Broj telefona mora biti srpski mobilni broj koji počinje sa 06.", null);

        if (await HasConfirmedBookingWithinSevenDaysAsync(request.SalonId, normalizedPhone, request.Date, cancellationToken))
            return new(false, "CUSTOMER_WEEKLY_LIMIT", "Za ovaj broj telefona već postoji rezervacija u periodu od sedam dana.", null);

        if (await IsWorkerSlotOccupiedAsync(request.SalonId, worker.Id, request.Date, request.Time, service.DurationMinutes, cancellationToken))
            return new(false, "SLOT_TAKEN", "Termin je u međuvremenu zauzet.", null);

        var appointment = CreateConfirmedAppointment(request, worker, service);
        db.Appointments.Add(appointment);
        await db.SaveChangesAsync(cancellationToken);
        return new(true, null, "Termin je zakazan.", ToDto(appointment, worker, service));
    }

    private static Appointment CreateConfirmedAppointment(BookAppointmentCommand request, Worker worker, SalonService service)
        => new($"BR-{Guid.NewGuid().ToString("N")[..6].ToUpperInvariant()}", "confirmed", request.SalonId,
            worker.Id, service.Id, request.Date, request.Time, request.CustomerName.Trim(), request.Phone.Trim(), DateTime.UtcNow, null, null);

    private async Task<SalonService?> FindActiveServiceAsync(string salonId, string serviceName, CancellationToken cancellationToken)
    {
        var services = await db.Services.Where(x => x.SalonId == salonId && x.Active).ToListAsync(cancellationToken);
        return services.FirstOrDefault(x => string.Equals(x.Name, serviceName.Trim(), StringComparison.OrdinalIgnoreCase));
    }

    private async Task<Worker?> FindActiveWorkerAsync(string salonId, string workerName, CancellationToken cancellationToken)
    {
        var workers = await db.Workers.Where(x => x.SalonId == salonId && x.Active).ToListAsync(cancellationToken);
        return workers.FirstOrDefault(x => string.Equals(x.Name, workerName.Trim(), StringComparison.OrdinalIgnoreCase));
    }

    private static bool IsValidSerbianMobilePhone(string normalizedPhone)
        => normalizedPhone.Length is >= 9 and <= 10 && normalizedPhone.StartsWith("06", StringComparison.Ordinal);

    private async Task<bool> HasConfirmedBookingWithinSevenDaysAsync(
        string salonId, string normalizedPhone, DateOnly requestedDate, CancellationToken cancellationToken)
    {
        var confirmedAppointments = await db.Appointments.AsNoTracking()
            .Where(x => x.SalonId == salonId && x.Status == "confirmed")
            .ToListAsync(cancellationToken);
        return confirmedAppointments.Any(x =>
            Digits(x.Phone) == normalizedPhone && Math.Abs(x.Date.DayNumber - requestedDate.DayNumber) < 7);
    }

    private async Task<bool> IsWorkerSlotOccupiedAsync(
        string salonId, string workerId, DateOnly date, TimeOnly time, int durationMinutes, CancellationToken cancellationToken)
    {
        var sameDayAppointments = await db.Appointments.AsNoTracking().Include(x => x.Service)
            .Where(x => x.SalonId == salonId && x.Status == "confirmed" && x.Date == date && x.WorkerId == workerId)
            .ToListAsync(cancellationToken);
        return sameDayAppointments.Any(x => Overlaps(x.Time, x.Service.DurationMinutes, time, durationMinutes));
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
        var phoneMatches = await FindConfirmedAppointmentsByPhoneAsync(request, phone, cancellationToken);
        if (phoneMatches.Count > 1) return new(false, "APPOINTMENT_AMBIGUOUS", "Više termina se poklapa sa datumom, vremenom i brojem telefona; vlasnik treba da proveri koji termin otkazuje.", null);
        var appointment = phoneMatches.SingleOrDefault();
        if (appointment is null) return new(false, "APPOINTMENT_NOT_FOUND", "Potvrđen termin nije pronađen.", null);
        if (!IsValidSerbianMobilePhone(phone))
            return new(false, "INVALID_PHONE", "Broj telefona mora biti srpski mobilni broj koji počinje sa 06.", null);
        if (await HasCustomerCancelledWithinSevenDaysAsync(request.SalonId, phone, cancellationToken))
            return new(false, "CUSTOMER_WEEKLY_CANCEL_LIMIT", "Već ste jednom otkazali termin u poslednjih sedam dana. Za novo otkazivanje kontaktirajte salon.", null);

        appointment.Cancel("customer", DateTime.UtcNow);
        await db.SaveChangesAsync(cancellationToken);
        return new(true, null, "Termin je otkazan.", BookAppointmentHandler.ToDto(appointment, appointment.Worker, appointment.Service));
    }

    private async Task<List<Appointment>> FindConfirmedAppointmentsByPhoneAsync(
        CancelAppointmentCommand request, string normalizedPhone, CancellationToken cancellationToken)
    {
        var matches = await db.Appointments.Include(x => x.Worker).Include(x => x.Service)
            .Where(x => x.SalonId == request.SalonId && x.Status == "confirmed" && x.Date == request.Date && x.Time == request.Time)
            .ToListAsync(cancellationToken);
        return matches.Where(x => BookAppointmentHandler.Digits(x.Phone) == normalizedPhone).ToList();
    }

    private static bool IsValidSerbianMobilePhone(string normalizedPhone)
        => normalizedPhone.Length is >= 9 and <= 10 && normalizedPhone.StartsWith("06", StringComparison.Ordinal);

    private async Task<bool> HasCustomerCancelledWithinSevenDaysAsync(
        string salonId, string normalizedPhone, CancellationToken cancellationToken)
    {
        var recentCancellation = await db.Appointments.AsNoTracking()
            .Where(x => x.SalonId == salonId && x.Status == "cancelled" && x.CancelledBy == "customer" && x.CancelledAt != null)
            .ToListAsync(cancellationToken);
        return recentCancellation.Any(x => BookAppointmentHandler.Digits(x.Phone) == normalizedPhone
            && DateTime.UtcNow - x.CancelledAt!.Value < TimeSpan.FromDays(7));
    }

}
