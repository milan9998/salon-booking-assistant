namespace SalonBooking.Domain.Booking;

public static class CustomerPhone
{
    public static string Normalize(string? value)
    {
        var digits = new string((value ?? "").Where(char.IsAsciiDigit).ToArray());
        if (digits.StartsWith("00", StringComparison.Ordinal)) digits = digits[2..];
        return digits.StartsWith("3816", StringComparison.Ordinal) ? "0" + digits[3..] : digits;
    }

    public static bool IsValid(string value)
        => value.Length is >= 9 and <= 10 && value.StartsWith("06", StringComparison.Ordinal);
}
