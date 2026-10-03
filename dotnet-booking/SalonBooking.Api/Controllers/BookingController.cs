using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MediatR;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using SalonBooking.Application.Appointments;
using SalonBooking.Application.Salons;
using SalonBooking.Application.Common;
using SalonBooking.Api;

namespace SalonBooking.Api.Controllers;

[ApiController]
[Route("api")]
public sealed class BookingController(IMediator mediator, IBookingDbContext db) : ControllerBase
{
    [HttpGet("health")]
    [AllowAnonymous]
    public async Task<IActionResult> Health(CancellationToken cancellationToken)
        => Ok(new { ok = true, storage = "postgresql", salons = await db.Salons.CountAsync(cancellationToken) });

    [HttpGet("salons")]
    public async Task<IActionResult> Salons(CancellationToken cancellationToken)
        => await mediator.Send(new GetSalonsQuery(), cancellationToken) is { } salons ? Ok(new { ok = true, salons }) : Ok();

    [HttpGet("appointments")]
    public async Task<IActionResult> Appointments([FromQuery(Name = "salon_id")] string salonId, CancellationToken cancellationToken)
    {
        if (!await Authorize(salonId, cancellationToken)) return Unauthorized(new { ok = false, error = "Unauthorized" });
        return Ok(new { ok = true, salon_id = salonId, appointments = await mediator.Send(new GetAppointmentsQuery(salonId), cancellationToken) });
    }

    [HttpPost("check-availability")]
    public async Task<IActionResult> CheckAvailability([FromBody] AvailabilityRequest request, CancellationToken cancellationToken)
    {
        var salonId = request.SalonId ?? HeaderSalonId();
        if (!await Authorize(salonId, cancellationToken)) return Unauthorized(new { ok = false, error = "Unauthorized" });
        if (!DateOnly.TryParseExact(request.Date, "yyyy-MM-dd", out var date)) return Ok(new { ok = false, code = "INVALID_DATE", reason = "Potreban je važeći datum u formatu YYYY-MM-DD." });
        var result = await mediator.Send(new CheckAvailabilityQuery(salonId, date, request.Service ?? "", request.Barber, request.Time), cancellationToken);
        return Ok(result);
    }

    [HttpPost("book-appointment")]
    public async Task<IActionResult> Book([FromBody] BookRequest request, CancellationToken cancellationToken)
    {
        var salonId = request.SalonId ?? HeaderSalonId();
        if (!await Authorize(salonId, cancellationToken)) return Unauthorized(new { ok = false, error = "Unauthorized" });
        if (!DateOnly.TryParseExact(request.Date, "yyyy-MM-dd", out var date) || !TimeOnly.TryParseExact(request.Time, "HH:mm", out var time)) return BadRequest(new { ok = false, error = "Potrebni su date u formatu YYYY-MM-DD i time u formatu HH:MM." });
        var result = await mediator.Send(new BookAppointmentCommand(salonId, date, time, request.Service ?? "", request.Barber ?? "", request.CustomerName ?? "", request.Phone ?? ""), cancellationToken);
        return result.Ok ? StatusCode(201, result) : Ok(result);
    }

    [HttpPost("cancel-appointment")]
    public async Task<IActionResult> Cancel([FromBody] CancelRequest request, CancellationToken cancellationToken)
    {
        var salonId = request.SalonId ?? HeaderSalonId();
        if (!await Authorize(salonId, cancellationToken)) return Unauthorized(new { ok = false, error = "Unauthorized" });
        if (!DateOnly.TryParseExact(request.Date, "yyyy-MM-dd", out var date) || !TimeOnly.TryParseExact(request.Time, "HH:mm", out var time)) return BadRequest(new { ok = false, error = "Potrebni su date u formatu YYYY-MM-DD i time u formatu HH:MM." });
        var result = await mediator.Send(new CancelAppointmentCommand(salonId, date, time, request.Phone ?? ""), cancellationToken);
        return result.Ok ? Ok(result) : NotFound(result);
    }

    private string HeaderSalonId() => Request.Headers.TryGetValue("X-Salon-Id", out var value) && !string.IsNullOrWhiteSpace(value) ? value.ToString() : "default";

    private async Task<bool> Authorize(string salonId, CancellationToken cancellationToken)
    {
        var salon = await db.Salons.AsNoTracking().SingleOrDefaultAsync(x => x.Id == salonId, cancellationToken);
        if (salon is null) return false;
        if (SessionStore.TryGet(Request, out var identity) && identity is not null)
            return identity.Kind == "platform" || identity.SalonId == salonId;
        var supplied = Request.Headers["X-Agent-Secret"].ToString();
        if (string.IsNullOrWhiteSpace(supplied) || string.IsNullOrWhiteSpace(salon.WebhookSecretHash)) return false;
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(supplied))).ToLowerInvariant();
        return CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(digest), Encoding.UTF8.GetBytes(salon.WebhookSecretHash));
    }
}

public sealed record AvailabilityRequest(string? SalonId, string? Date, string? Service, string? Barber, string? Time);
public sealed record BookRequest(string? SalonId, string? Date, string? Time, string? Service, string? Barber, string? CustomerName, string? Phone);
public sealed record CancelRequest(string? SalonId, string? CustomerName, string? Date, string? Time, string? Phone);

[AttributeUsage(AttributeTargets.Method)]
public sealed class AllowAnonymousAttribute : Attribute { }
