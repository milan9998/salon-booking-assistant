using System.Security.Cryptography;
using System.Text;
using MediatR;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using SalonBooking.Api;
using SalonBooking.Application.Common;

namespace SalonBooking.Api.Controllers;

[ApiController]
[Route("api")]
public sealed class AuthController(IBookingDbContext db) : ControllerBase
{
    [HttpPost("login")]
    public async Task<IActionResult> Login([FromBody] LoginRequest request, CancellationToken cancellationToken)
    {
        var username = (request.Username ?? "").Trim();
        var password = request.Password ?? "";
        var identity = await AuthenticateAsync(username, password, cancellationToken);
        if (identity is null) return Unauthorized(new { ok = false, error = "Pogrešno korisničko ime ili lozinka" });
        var token = SessionStore.Issue(identity);
        return Ok(new { ok = true, token, user = identity.Username, role = identity.Kind, salon_id = identity.SalonId });
    }

    private async Task<ApiIdentity?> AuthenticateAsync(string username, string password, CancellationToken cancellationToken)
    {
        if (ArePlatformCredentialsValid(username, password)) return new("platform", username, null);
        var account = await db.OwnerAccounts.SingleOrDefaultAsync(x => x.Username == username, cancellationToken);
        return account is not null && VerifyPassword(password, account.PasswordSalt, account.PasswordHash)
            ? new("owner", account.Username, account.SalonId)
            : null;
    }

    private static bool ArePlatformCredentialsValid(string username, string password)
    {
        var adminUser = Environment.GetEnvironmentVariable("ADMIN_USER") ?? "admin";
        var adminPassword = Environment.GetEnvironmentVariable("ADMIN_PASSWORD") ?? "";
        return !string.IsNullOrWhiteSpace(adminPassword)
            && string.Equals(username, adminUser, StringComparison.OrdinalIgnoreCase) && password == adminPassword;
    }

    [HttpGet("me")]
    public IActionResult Me()
        => SessionStore.TryGet(Request, out var identity) && identity is not null
            ? Ok(new { ok = true, user = identity.Username, role = identity.Kind, salon_id = identity.SalonId })
            : Unauthorized(new { ok = false, error = "Session required" });

    [HttpPost("account/password")]
    public async Task<IActionResult> ChangePassword([FromBody] PasswordChangeRequest request, CancellationToken cancellationToken)
    {
        if (!SessionStore.TryGet(Request, out var identity) || identity is null || identity.Kind != "owner")
            return StatusCode(403, new { ok = false, error = "Vlasnički nalog je obavezan" });
        var account = await db.OwnerAccounts.SingleOrDefaultAsync(x => x.Username == identity.Username, cancellationToken);
        if (account is null || !VerifyPassword(request.CurrentPassword ?? "", account.PasswordSalt, account.PasswordHash))
            return StatusCode(403, new { ok = false, error = "Trenutna lozinka nije tačna" });
        if (string.IsNullOrWhiteSpace(request.NewPassword) || request.NewPassword.Length is < 14 or > 200)
            return BadRequest(new { ok = false, error = "Nova lozinka mora imati najmanje 14 znakova" });
        var created = CreatePassword(request.NewPassword);
        account.ChangePassword(created.Salt, created.Hash);
        await db.SaveChangesAsync(cancellationToken);
        return Ok(new { ok = true });
    }

    internal static (string Salt, string Hash) CreatePassword(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var derived = Rfc2898DeriveBytes.Pbkdf2(password, salt, 120_000, HashAlgorithmName.SHA256, 64);
        return (Convert.ToBase64String(salt), $"pbkdf2$120000${Convert.ToBase64String(salt)}${Convert.ToBase64String(derived)}");
    }

    private static bool VerifyPassword(string password, string saltText, string stored)
    {
        if (!stored.StartsWith("pbkdf2$", StringComparison.Ordinal)) return false;
        var pieces = stored.Split('$');
        if (pieces.Length != 4 || !int.TryParse(pieces[1], out var iterations)) return false;
        try
        {
            var salt = Convert.FromBase64String(pieces[2]);
            var expected = Convert.FromBase64String(pieces[3]);
            var actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, expected.Length);
            return CryptographicOperations.FixedTimeEquals(actual, expected);
        }
        catch (FormatException) { return false; }
    }
}

public sealed record LoginRequest(string? Username, string? Password);
public sealed record PasswordChangeRequest(string? CurrentPassword, string? NewPassword);
