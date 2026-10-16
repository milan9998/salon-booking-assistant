using System.Text.Json;

namespace SalonBooking.Domain.Booking;

public static class ScheduleValidation
{
    public static bool IsValid(JsonElement schedule, IReadOnlyCollection<string> staff)
    {
        if (!ValidWindow(schedule)) return false;
        if (!schedule.TryGetProperty("staff", out var overrides)) return true;
        return overrides.ValueKind == JsonValueKind.Object && overrides.EnumerateObject()
            .All(x => staff.Contains(x.Name) && ValidWindow(x.Value));
    }

    private static bool ValidWindow(JsonElement window)
    {
        if (window.ValueKind != JsonValueKind.Object
            || !window.TryGetProperty("weekdays", out var days) || days.ValueKind != JsonValueKind.Array
            || !TryTime(window, "start", out var start) || !TryTime(window, "end", out var end) || end <= start)
            return false;
        var seen = new HashSet<int>();
        foreach (var day in days.EnumerateArray())
            if (day.ValueKind != JsonValueKind.Number || !day.TryGetInt32(out var n) || n is < 0 or > 6 || !seen.Add(n)) return false;
        if (!window.TryGetProperty("breaks", out var pauses)) return true;
        if (pauses.ValueKind != JsonValueKind.Array) return false;
        return pauses.EnumerateArray().All(x => x.ValueKind == JsonValueKind.Object
            && TryTime(x, "start", out var a) && TryTime(x, "end", out var b) && a < b && a >= start && b <= end);
    }

    private static bool TryTime(JsonElement window, string field, out TimeOnly time)
    {
        time = default;
        return window.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String
            && TimeOnly.TryParseExact(value.GetString(), "HH:mm", out time);
    }
}
