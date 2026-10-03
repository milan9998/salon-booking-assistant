using System.Collections.Concurrent;

namespace SalonBooking.Api;

public sealed record ApiIdentity(string Kind, string Username, string? SalonId);

public static class SessionStore
{
    private static readonly ConcurrentDictionary<string, (ApiIdentity Identity, DateTime ExpiresAt)> Sessions = new();

    public static string Issue(ApiIdentity identity)
    {
        var token = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        Sessions[token] = (identity, DateTime.UtcNow.AddHours(8));
        return token;
    }

    public static bool TryGet(HttpRequest request, out ApiIdentity? identity)
    {
        identity = null;
        var value = request.Headers.Authorization.ToString();
        if (!value.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return false;
        var token = value[7..].Trim();
        if (!Sessions.TryGetValue(token, out var session)) return false;
        if (session.ExpiresAt <= DateTime.UtcNow) { Sessions.TryRemove(token, out _); return false; }
        identity = session.Identity;
        return true;
    }
}
