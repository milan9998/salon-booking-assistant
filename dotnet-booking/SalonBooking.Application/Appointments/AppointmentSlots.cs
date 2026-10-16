using SalonBooking.Domain.Booking;
using SalonBooking.Domain.Entities;

namespace SalonBooking.Application.Appointments;

public static class AppointmentSlots
{
    public static bool Overlaps(TimeOnly first, int firstMinutes, TimeOnly second, int secondMinutes)
        => first.ToTimeSpan().TotalMinutes < second.ToTimeSpan().TotalMinutes + secondMinutes
            && second.ToTimeSpan().TotalMinutes < first.ToTimeSpan().TotalMinutes + firstMinutes;

    public static List<string> Available(DateOnly date, Salon salon, Worker worker, SalonService service,
        IReadOnlyList<Appointment> appointments)
    {
        var window = BookingPolicy.ReadSchedule(salon, worker.Name);
        if (!TimeOnly.TryParseExact(window.Start, "HH:mm", out var start)
            || !TimeOnly.TryParseExact(window.End, "HH:mm", out var end)) return [];
        var result = new List<string>();
        var firstMinute = ((int)start.ToTimeSpan().TotalMinutes + 29) / 30 * 30;
        for (var minute = firstMinute;
             minute + service.DurationMinutes <= end.ToTimeSpan().TotalMinutes; minute += 30)
        {
            var time = TimeOnly.FromTimeSpan(TimeSpan.FromMinutes(minute));
            if (BookingPolicy.CheckSlot(time.ToString("HH:mm"), service.DurationMinutes, date, worker.Name, salon).Code == "AVAILABLE"
                && !appointments.Any(x => x.Date == date && Overlaps(x.Time, x.Service.DurationMinutes, time, service.DurationMinutes)))
                result.Add(time.ToString("HH:mm"));
        }
        return result;
    }
}
