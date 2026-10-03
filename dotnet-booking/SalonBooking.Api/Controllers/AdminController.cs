using System.Text.Json;
using MediatR;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using SalonBooking.Api;
using SalonBooking.Application.Appointments;
using SalonBooking.Application.Common;
using SalonBooking.Application.Salons;
using SalonBooking.Domain.Booking;
using SalonBooking.Domain.Entities;

namespace SalonBooking.Api.Controllers;

[ApiController]
[Route("api")]
public sealed class AdminController(IBookingDbContext db, IMediator mediator) : ControllerBase
{
    [HttpGet("admin/salons")]
    public async Task<IActionResult> GetSalons(CancellationToken cancellationToken)
    {
        if (!SessionStore.TryGet(Request, out var identity) || identity is null) return Unauthorized(new { ok = false, error = "Unauthorized" });
        var salons = await mediator.Send(new GetSalonsQuery(), cancellationToken);
        if (identity.Kind == "owner") salons = salons.Where(x => x.Id == identity.SalonId).ToList();
        return Ok(new { ok = true, salons });
    }

    [HttpPost("admin/salons")]
    public async Task<IActionResult> CreateSalon([FromBody] CreateSalonRequest request, CancellationToken cancellationToken)
    {
        if (!IsPlatform()) return StatusCode(403, new { ok = false, error = "Platform admin required" });
        var name = (request.Name ?? "").Trim();
        var agentId = (request.AgentId ?? "").Trim();
        var workers = Split(request.Barbers);
        var services = Split(request.Services);
        if (name.Length is < 1 or > 120 || !System.Text.RegularExpressions.Regex.IsMatch(agentId, "^agent_[A-Za-z0-9]+$") || workers.Count == 0 || services.Count == 0)
            return BadRequest(new { ok = false, error = "Naziv, važeći agent ID, najmanje jedan radnik i jedna usluga su obavezni." });
        var id = Slug(name);
        var suffix = 2;
        while (await db.Salons.AnyAsync(x => x.Id == id, cancellationToken)) id = $"{Slug(name)}-{suffix++}";
        var schedule = "{\"weekdays\":[1,2,3,4,5,6],\"start\":\"09:00\",\"end\":\"18:00\",\"breaks\":[],\"staff\":{}}";
        var salon = new Salon(id, name, agentId, "Europe/Belgrade", JsonSerializer.Serialize(services), JsonSerializer.Serialize(workers), request.KnowledgeNotes?.Trim() ?? "", DateTime.UtcNow, null, null, schedule, false);
        db.Salons.Add(salon);
        foreach (var worker in workers) db.Workers.Add(new Worker($"{id}:worker:{Slug(worker)}", id, worker));
        foreach (var service in services) db.Services.Add(new SalonService($"{id}:service:{Slug(service)}", id, service, BookingPolicy.Durations.GetValueOrDefault(service, 30)));
        await db.SaveChangesAsync(cancellationToken);
        var result = (await mediator.Send(new GetSalonsQuery(), cancellationToken)).Single(x => x.Id == id);
        return Created($"/api/admin/salons/{id}", new { ok = true, salon = result });
    }

    [HttpPost("admin/owners")]
    public async Task<IActionResult> CreateOwner([FromBody] CreateOwnerRequest request, CancellationToken cancellationToken)
    {
        if (!IsPlatform()) return StatusCode(403, new { ok = false, error = "Platform admin required" });
        var username = (request.Username ?? "").Trim().ToLowerInvariant();
        if (!System.Text.RegularExpressions.Regex.IsMatch(username, "^[a-zA-Z0-9._-]{4,50}$") || await db.OwnerAccounts.AnyAsync(x => x.Username == username, cancellationToken))
            return BadRequest(new { ok = false, error = "Potreban je jedinstven korisnički nalog (4–50 znakova)." });
        var salon = await db.Salons.SingleOrDefaultAsync(x => x.Id == request.SalonId, cancellationToken);
        if (salon is null) return BadRequest(new { ok = false, error = "Salon nije pronađen." });
        var temporary = $"Salon-{Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(8))}!";
        var created = AuthController.CreatePassword(temporary);
        db.OwnerAccounts.Add(new OwnerAccount(username, salon.Id, created.Salt, created.Hash, DateTime.UtcNow));
        await db.SaveChangesAsync(cancellationToken);
        return StatusCode(201, new { ok = true, username, salon_id = salon.Id, temporary_password = temporary });
    }

    [HttpPatch("salons/{salonId}/schedule")]
    public async Task<IActionResult> UpdateSchedule(string salonId, [FromBody] ScheduleRequest request, CancellationToken cancellationToken)
    {
        if (!CanManage(salonId)) return StatusCode(403, new { ok = false, error = "Salon nije dostupan ovom nalogu" });
        if (request.Schedule.ValueKind != JsonValueKind.Object) return BadRequest(new { ok = false, error = "Neispravan raspored" });
        var salon = await db.Salons.SingleOrDefaultAsync(x => x.Id == salonId, cancellationToken);
        if (salon is null) return NotFound(new { ok = false, error = "Salon nije pronađen" });
        salon.UpdateSchedule(request.Schedule.GetRawText());
        await db.SaveChangesAsync(cancellationToken);
        return Ok(new { ok = true, salon = (await mediator.Send(new GetSalonsQuery(), cancellationToken)).Single(x => x.Id == salonId) });
    }

    [HttpGet("services")]
    public async Task<IActionResult> Services([FromQuery(Name = "salon_id")] string? salonId, CancellationToken cancellationToken)
    {
        if (!SessionStore.TryGet(Request, out var identity) || identity is null) return Unauthorized(new { ok = false, error = "Unauthorized" });
        salonId = identity.Kind == "owner" ? identity.SalonId : (salonId ?? "default");
        var salon = await db.Salons.AsNoTracking().SingleOrDefaultAsync(x => x.Id == salonId, cancellationToken);
        if (salon is null) return NotFound(new { ok = false, error = "Salon nije pronađen" });
        var services = await db.Services.AsNoTracking().Where(x => x.SalonId == salon.Id && x.Active).OrderBy(x => x.Name).ToListAsync(cancellationToken);
        var workers = await db.Workers.AsNoTracking().Where(x => x.SalonId == salon.Id && x.Active).OrderBy(x => x.Name).ToListAsync(cancellationToken);
        return Ok(new { ok = true, salon_id = salon.Id, services, barbers = workers.Select(x => x.Name).ToList() });
    }

    [HttpPost("owner/cancel-appointment")]
    public async Task<IActionResult> OwnerCancel([FromBody] OwnerCancelRequest request, CancellationToken cancellationToken)
    {
        if (!SessionStore.TryGet(Request, out var identity) || identity is null || (identity.Kind != "owner" && identity.Kind != "platform"))
            return StatusCode(403, new { ok = false, error = "Session required" });
        var appointment = await db.Appointments.Include(x => x.Worker).Include(x => x.Service).SingleOrDefaultAsync(x => x.Id == request.AppointmentId, cancellationToken);
        if (appointment is null) return NotFound(new { ok = false, error = "Termin nije pronađen" });
        if (identity.Kind == "owner" && identity.SalonId != appointment.SalonId) return StatusCode(403, new { ok = false, error = "Salon nije dostupan ovom nalogu" });
        if (appointment.Status != "confirmed") return BadRequest(new { ok = false, error = "Termin više nije potvrđen" });
        appointment.Cancel("owner", DateTime.UtcNow);
        await db.SaveChangesAsync(cancellationToken);
        return Ok(new { ok = true, appointment = BookAppointmentHandler.ToDto(appointment, appointment.Worker, appointment.Service) });
    }

    private bool IsPlatform() => SessionStore.TryGet(Request, out var identity) && identity?.Kind == "platform";
    private bool CanManage(string salonId) => SessionStore.TryGet(Request, out var identity) && identity is not null && (identity.Kind == "platform" || identity.SalonId == salonId);
    private static List<string> Split(string? value) => (value ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    private static string Slug(string value) => string.Concat(value.ToLowerInvariant().Select(c => char.IsLetterOrDigit(c) ? c : '-')).Trim('-');
}

public sealed record CreateSalonRequest(string? Name, string? AgentId, string? Barbers, string? Services, string? KnowledgeNotes);
public sealed record CreateOwnerRequest(string? SalonId, string? Username);
public sealed record ScheduleRequest(JsonElement Schedule);
public sealed record OwnerCancelRequest(string AppointmentId);
