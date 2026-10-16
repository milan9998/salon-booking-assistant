using System.Globalization;
using System.Text.Json;
using SalonBooking.Domain.Entities;

namespace SalonBooking.Domain.Booking;

public sealed record ScheduleWindow(int[] Weekdays, string Start, string End, BreakWindow[] Breaks);
public sealed record BreakWindow(string Start, string End);
public sealed record SlotDecision(string Code, string Reason);

public static class BookingPolicy
{
    public static readonly IReadOnlyDictionary<string, int> Durations = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
    {
        ["sisanje"] = 30, ["brada"] = 30, ["sisanje-i-brada"] = 60,
        ["feniranje"] = 30, ["farbanje"] = 90,
        ["manikir"] = 60, ["pedikir"] = 60, ["tretman-lica"] = 60,
        ["relaks-masaza"] = 60, ["sportska-masaza"] = 60, ["masaza-ledja"] = 45,
    };

    public static ScheduleWindow ReadSchedule(Salon salon, string barber)
    {
        using var document = JsonDocument.Parse(salon.ScheduleJson);
        var root = document.RootElement;
        var window = root;
        if (root.TryGetProperty("staff", out var staff) && staff.TryGetProperty(barber, out var staffWindow)) window = staffWindow;
        var weekdays = window.TryGetProperty("weekdays", out var days) ? days.EnumerateArray().Select(x => x.GetInt32()).ToArray() : [1, 2, 3, 4, 5, 6];
        var start = window.TryGetProperty("start", out var startElement) ? startElement.GetString() ?? "09:00" : "09:00";
        var end = window.TryGetProperty("end", out var endElement) ? endElement.GetString() ?? "18:00" : "18:00";
        return new ScheduleWindow(weekdays, start, end, ReadBreaks(window));
    }

    private static BreakWindow[] ReadBreaks(JsonElement window)
    {
        var breaks = new List<BreakWindow>();
        if (window.TryGetProperty("breaks", out var breaksElement))
        {
            foreach (var item in breaksElement.EnumerateArray()) breaks.Add(new BreakWindow(item.GetProperty("start").GetString()!, item.GetProperty("end").GetString()!));
        }
        return breaks.ToArray();
    }

    public static DateTimeOffset LocalNow(Salon salon, TimeZoneInfo? zone = null, DateTimeOffset? now = null)
        => TimeZoneInfo.ConvertTime(now ?? DateTimeOffset.UtcNow, zone ?? TimeZoneInfo.FindSystemTimeZoneById(salon.Timezone));

    public static SlotDecision CheckSlot(string time, int durationMinutes, DateOnly date, string barber, Salon salon,
        TimeZoneInfo? zone = null, DateTimeOffset? now = null)
    {
        var window = ReadSchedule(salon, barber);
        var start = TimeOnly.ParseExact(time, "HH:mm", CultureInfo.InvariantCulture);
        var localNow = LocalNow(salon, zone, now);
        var today = DateOnly.FromDateTime(localNow.DateTime);
        if (date < today) return new("PAST_DATE", "Ne zakazujemo termine u prošlosti.");
        if (date == today && start <= TimeOnly.FromDateTime(localNow.DateTime))
            return new("PAST_TIME", "To vreme je već prošlo.");
        if (durationMinutes <= 0) return new("INVALID_SERVICE_DURATION", "Trajanje usluge nije ispravno podešeno.");
        if (!window.Weekdays.Contains((int)date.DayOfWeek)) return new("CLOSED_DAY", $"{barber} ne radi tog dana.");
        if (start.Minute % 30 != 0) return new("INVALID_TIME", "Termini počinju na pun sat ili pola sata.");
        var end = start.AddMinutes(durationMinutes);
        var close = TimeOnly.ParseExact(window.End, "HH:mm", CultureInfo.InvariantCulture);
        if (start < TimeOnly.ParseExact(window.Start, "HH:mm", CultureInfo.InvariantCulture)
            || start.ToTimeSpan().TotalMinutes + durationMinutes > close.ToTimeSpan().TotalMinutes)
            return CreateOutsideHoursDecision(window, barber, durationMinutes, close);
        var pause = FindOverlappingBreak(window.Breaks, start, end);
        if (pause is not null) return new("ON_BREAK", $"{barber} ima pauzu od {pause.Start} do {pause.End}.");
        return new("AVAILABLE", "Traženo vreme je u radnom vremenu.");
    }

    private static SlotDecision CreateOutsideHoursDecision(ScheduleWindow window, string barber, int durationMinutes, TimeOnly close)
    {
        var last = close.AddMinutes(-durationMinutes);
        var detail = last >= TimeOnly.ParseExact(window.Start, "HH:mm", CultureInfo.InvariantCulture)
            ? $"Za ovu uslugu poslednji početak termina je {last:HH\\:mm}."
            : "Za ovu uslugu nema dovoljno vremena u rasporedu.";
        return new("OUTSIDE_HOURS", $"Radno vreme za {barber} je od {window.Start} do {window.End}. {detail}");
    }

    private static BreakWindow? FindOverlappingBreak(IEnumerable<BreakWindow> breaks, TimeOnly start, TimeOnly end)
        => breaks.FirstOrDefault(x => start < TimeOnly.ParseExact(x.End, "HH:mm", CultureInfo.InvariantCulture)
            && TimeOnly.ParseExact(x.Start, "HH:mm", CultureInfo.InvariantCulture) < end);
}
