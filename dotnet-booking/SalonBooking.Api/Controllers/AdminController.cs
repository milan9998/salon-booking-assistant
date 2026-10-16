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
public sealed class AdminController(IBookingDbContext db, IMediator mediator, IBookingTransactionRunner transactionRunner) : ControllerBase
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
        if (!IsValidSalonProfile(name, agentId, workers, services))
            return BadRequest(new { ok = false, error = "Naziv, važeći agent ID, najmanje jedan radnik i jedna usluga su obavezni." });
        if (await db.Salons.AnyAsync(x => x.AgentId == agentId, cancellationToken))
            return BadRequest(new { ok = false, error = "Ovaj agent već pripada drugom salonu. Izaberite poseban agent." });
        var id = await GenerateUniqueSalonIdAsync(name, cancellationToken);
        var salon = CreateSalonProfile(id, name, agentId, workers, services, request.KnowledgeNotes);
        db.Salons.Add(salon);
        AddSalonWorkers(id, workers);
        AddSalonServices(id, services);
        await db.SaveChangesAsync(cancellationToken);
        var result = (await mediator.Send(new GetSalonsQuery(), cancellationToken)).Single(x => x.Id == id);
        return Created($"/api/admin/salons/{id}", new { ok = true, salon = result });
    }

    [HttpPost("admin/owners")]
    public async Task<IActionResult> CreateOwner([FromBody] CreateOwnerRequest request, CancellationToken cancellationToken)
    {
        if (!IsPlatform()) return StatusCode(403, new { ok = false, error = "Platform admin required" });
        var username = (request.Username ?? "").Trim().ToLowerInvariant();
        if (!await IsOwnerUsernameAvailableAsync(username, cancellationToken))
            return BadRequest(new { ok = false, error = "Potreban je jedinstven korisnički nalog (4–50 znakova)." });
        var salon = await db.Salons.SingleOrDefaultAsync(x => x.Id == request.SalonId, cancellationToken);
        if (salon is null) return BadRequest(new { ok = false, error = "Salon nije pronađen." });
        var temporary = GenerateTemporaryOwnerPassword();
        var created = AuthController.CreatePassword(temporary);
        db.OwnerAccounts.Add(new OwnerAccount(username, salon.Id, created.Salt, created.Hash, DateTime.UtcNow));
        await db.SaveChangesAsync(cancellationToken);
        return StatusCode(201, new { ok = true, username, salon_id = salon.Id, temporary_password = temporary });
    }

    private static bool IsValidSalonProfile(string name, string agentId, IReadOnlyCollection<string> workers, IReadOnlyCollection<string> services)
        => name.Length is >= 1 and <= 120 && System.Text.RegularExpressions.Regex.IsMatch(agentId, "^agent_[A-Za-z0-9]+$")
            && workers.Count > 0 && services.Count > 0;

    private async Task<string> GenerateUniqueSalonIdAsync(string name, CancellationToken cancellationToken)
    {
        var id = Slug(name);
        var suffix = 2;
        while (await db.Salons.AnyAsync(x => x.Id == id, cancellationToken)) id = $"{Slug(name)}-{suffix++}";
        return id;
    }

    private static Salon CreateSalonProfile(string id, string name, string agentId, IReadOnlyList<string> workers,
        IReadOnlyList<string> services, string? knowledgeNotes)
    {
        const string schedule = "{\"weekdays\":[1,2,3,4,5,6],\"start\":\"09:00\",\"end\":\"18:00\",\"breaks\":[],\"staff\":{}}";
        return new(id, name, agentId, "Europe/Belgrade", JsonSerializer.Serialize(services), JsonSerializer.Serialize(workers),
            knowledgeNotes?.Trim() ?? "", DateTime.UtcNow, null, null, schedule, false);
    }

    private void AddSalonWorkers(string salonId, IEnumerable<string> names)
    {
        foreach (var name in names) db.Workers.Add(new Worker($"{salonId}:worker:{Slug(name)}", salonId, name));
    }

    private void AddSalonServices(string salonId, IEnumerable<string> names)
    {
        foreach (var name in names)
            db.Services.Add(new SalonService($"{salonId}:service:{Slug(name)}", salonId, name, BookingPolicy.Durations.GetValueOrDefault(name, 30)));
    }

    private async Task<bool> IsOwnerUsernameAvailableAsync(string username, CancellationToken cancellationToken)
        => System.Text.RegularExpressions.Regex.IsMatch(username, "^[a-zA-Z0-9._-]{4,50}$")
            && !await db.OwnerAccounts.AnyAsync(x => x.Username == username, cancellationToken);

    private static string GenerateTemporaryOwnerPassword()
        => $"Salon-{Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(8))}!";

    [HttpPatch("salons/{salonId}/schedule")]
    public async Task<IActionResult> UpdateSchedule(string salonId, [FromBody] ScheduleRequest request, CancellationToken cancellationToken)
    {
        if (!CanManage(salonId)) return StatusCode(403, new { ok = false, error = "Salon nije dostupan ovom nalogu" });
        if (request.Schedule.ValueKind != JsonValueKind.Object) return BadRequest(new { ok = false, error = "Neispravan raspored" });
        var salon = await db.Salons.SingleOrDefaultAsync(x => x.Id == salonId, cancellationToken);
        if (salon is null) return NotFound(new { ok = false, error = "Salon nije pronađen" });
        var workers = await db.Workers.Where(x => x.SalonId == salonId && x.Active).Select(x => x.Name).ToListAsync(cancellationToken);
        if (!ScheduleValidation.IsValid(request.Schedule, workers))
            return BadRequest(new { ok = false, error = "Proverite radne dane, početak/kraj radnog vremena i pauze." });
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
        var appointment = await db.Appointments.AsNoTracking().SingleOrDefaultAsync(x => x.Id == request.AppointmentId, cancellationToken);
        if (appointment is null) return NotFound(new { ok = false, error = "Termin nije pronađen" });
        if (identity.Kind == "owner" && identity.SalonId != appointment.SalonId) return StatusCode(403, new { ok = false, error = "Salon nije dostupan ovom nalogu" });
        return await transactionRunner.ExecuteWithLocksAsync<IActionResult>(
            [$"customer-week:{appointment.SalonId}:{CustomerPhone.Normalize(appointment.Phone)}"],
            token => CancelAsOwnerAsync(request.AppointmentId, token), cancellationToken);
    }

    private async Task<IActionResult> CancelAsOwnerAsync(string appointmentId, CancellationToken cancellationToken)
    {
        var appointment = await db.Appointments.Include(x => x.Worker).Include(x => x.Service)
            .SingleAsync(x => x.Id == appointmentId, cancellationToken);
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
