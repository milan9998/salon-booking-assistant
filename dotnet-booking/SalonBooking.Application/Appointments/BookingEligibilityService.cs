using Microsoft.EntityFrameworkCore;
using SalonBooking.Application.Common;
using SalonBooking.Domain.Booking;
using SalonBooking.Domain.Entities;

namespace SalonBooking.Application.Appointments;

public sealed record NextBookingSlot(DateOnly Date, string Time, string Barber);
public sealed record WeeklyBookingLimit(DateOnly NextEligibleDate, NextBookingSlot? NextAvailableSlot);

public sealed class BookingEligibilityService(IBookingDbContext db)
{
    public async Task<WeeklyBookingLimit?> CheckAsync(Salon salon, DateOnly requestedDate, string phone,
        Worker worker, SalonService service, CancellationToken cancellationToken)
    {
        var candidates = await db.Appointments.AsNoTracking()
            .Where(x => x.SalonId == salon.Id && x.Status == "confirmed" && x.Date >= requestedDate.AddDays(-6))
            .Select(x => new { x.Date, x.Phone }).ToListAsync(cancellationToken);
        var dates = candidates.Where(x => CustomerPhone.Normalize(x.Phone) == phone)
            .Select(x => x.Date).Distinct().OrderBy(x => x).ToList();
        if (!Conflicts(dates, requestedDate)) return null;

        var nextDate = requestedDate;
        foreach (var date in dates)
            if (Math.Abs(date.DayNumber - nextDate.DayNumber) < 7) nextDate = date.AddDays(7);

        var horizon = nextDate.AddDays(90);
        var appointments = await db.Appointments.AsNoTracking().Include(x => x.Service)
            .Where(x => x.SalonId == salon.Id && x.WorkerId == worker.Id && x.Status == "confirmed"
                && x.Date >= nextDate && x.Date < horizon).ToListAsync(cancellationToken);
        for (var date = nextDate; date < horizon; date = date.AddDays(1))
        {
            if (Conflicts(dates, date)) continue;
            var time = AppointmentSlots.Available(date, salon, worker, service, appointments).FirstOrDefault();
            if (time is not null) return new(nextDate, new(date, time, worker.Name));
        }
        return new(nextDate, null);
    }

    private static bool Conflicts(IEnumerable<DateOnly> dates, DateOnly requestedDate)
        => dates.Any(x => Math.Abs(x.DayNumber - requestedDate.DayNumber) < 7);
}
