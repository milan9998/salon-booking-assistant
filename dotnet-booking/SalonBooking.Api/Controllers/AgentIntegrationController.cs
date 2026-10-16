using System.Collections.Concurrent;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using SalonBooking.Application.Common;

namespace SalonBooking.Api.Controllers;

[ApiController]
[Route("api/admin/salons")]
public sealed class AgentIntegrationController(IBookingDbContext db, IAgentProvisioner provisioner) : ControllerBase
{
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> Locks = new();

    [HttpGet("~/api/admin/integrations")]
    public async Task<IActionResult> Integrations(CancellationToken cancellationToken)
    {
        if (!SessionStore.TryGet(Request, out var identity) || identity?.Kind != "platform")
            return Unauthorized(new { ok = false, error = "Platform admin required" });
        var salons = await db.Salons.AsNoTracking().OrderBy(x => x.Id).ToListAsync(cancellationToken);
        var workers = await db.Workers.AsNoTracking().Where(x => x.Active).ToListAsync(cancellationToken);
        var services = await db.Services.AsNoTracking().Where(x => x.Active).ToListAsync(cancellationToken);
        return Ok(new { ok = true, salons = salons.Select(s => new
        {
            s.Id, s.Name, s.AgentId, s.WebhookSecretId, s.IntegrationReady, s.KnowledgeNotes,
            services_json = System.Text.Json.JsonSerializer.Serialize(services.Where(x => x.SalonId == s.Id).Select(x => x.Name)),
            barbers_json = System.Text.Json.JsonSerializer.Serialize(workers.Where(x => x.SalonId == s.Id).Select(x => x.Name))
        }) });
    }

    [HttpPost("{salonId}/provision")]
    public async Task<IActionResult> Provision(string salonId, CancellationToken cancellationToken)
    {
        if (!SessionStore.TryGet(Request, out var identity) || identity is null)
            return Unauthorized(new { ok = false, error = "Session required" });
        if (identity.Kind != "platform") return StatusCode(403, new { ok = false, error = "Platform admin required" });
        var salon = await db.Salons.AsNoTracking().SingleOrDefaultAsync(x => x.Id == salonId, cancellationToken);
        if (salon is null) return NotFound(new { ok = false, error = "Salon nije pronađen." });
        var gate = Locks.GetOrAdd(salon.AgentId, _ => new SemaphoreSlim(1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            await provisioner.ProvisionAsync(salonId, cancellationToken);
            return Ok(new { ok = true, salon_id = salonId, agent_id = salon.AgentId });
        }
        catch (InvalidOperationException error) { return UnprocessableEntity(new { ok = false, error = error.Message }); }
        catch (HttpRequestException error) { return StatusCode(502, new { ok = false, error = error.Message }); }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        { return StatusCode(504, new { ok = false, error = "Povezivanje je isteklo. Pokušajte ponovo." }); }
        finally { gate.Release(); }
    }
}
