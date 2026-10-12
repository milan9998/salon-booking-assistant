using MediatR;
using Microsoft.EntityFrameworkCore;
using SalonBooking.Application.Common;
using System.Text.Json;
using SalonBooking.Domain.Entities;

namespace SalonBooking.Application.Salons;

public sealed record WorkerDto(string Id, string Name, bool Active);
public sealed record ServiceDto(string Id, string Name, int DurationMinutes, bool Active);
public sealed record SalonDto(string Id, string Name, string AgentId, string Timezone, string ServicesJson, string BarbersJson,
    string KnowledgeNotes, string ScheduleJson, bool IntegrationReady, IReadOnlyList<string> Services, IReadOnlyList<string> Barbers,
    JsonElement Schedule, IReadOnlyList<WorkerDto> Workers, IReadOnlyList<ServiceDto> NormalizedServices);

public sealed record GetSalonsQuery : IRequest<IReadOnlyList<SalonDto>>;

public sealed class GetSalonsQueryHandler(IBookingDbContext db) : IRequestHandler<GetSalonsQuery, IReadOnlyList<SalonDto>>
{
    public async Task<IReadOnlyList<SalonDto>> Handle(GetSalonsQuery request, CancellationToken cancellationToken)
    {
        var salons = await db.Salons.AsNoTracking().OrderBy(x => x.Name).ToListAsync(cancellationToken);
        var workers = await db.Workers.AsNoTracking().Where(x => x.Active).OrderBy(x => x.Name).ToListAsync(cancellationToken);
        var services = await db.Services.AsNoTracking().Where(x => x.Active).OrderBy(x => x.Name).ToListAsync(cancellationToken);
        return salons.Select(salon => MapSalonToDto(salon, workers, services)).ToList();
    }

    private static SalonDto MapSalonToDto(Salon salon, IReadOnlyList<Worker> workers, IReadOnlyList<SalonService> services)
    {
        var salonWorkers = workers.Where(w => w.SalonId == salon.Id).Select(w => new WorkerDto(w.Id, w.Name, w.Active)).ToList();
        var salonServices = services.Where(s => s.SalonId == salon.Id).Select(s => new ServiceDto(s.Id, s.Name, s.DurationMinutes, s.Active)).ToList();
        using var document = JsonDocument.Parse(salon.ScheduleJson);
        return new(salon.Id, salon.Name, salon.AgentId, salon.Timezone, salon.ServicesJson, salon.BarbersJson, salon.KnowledgeNotes,
            salon.ScheduleJson, salon.IntegrationReady, salonServices.Select(s => s.Name).ToList(), salonWorkers.Select(w => w.Name).ToList(),
            document.RootElement.Clone(), salonWorkers, salonServices);
    }
}
