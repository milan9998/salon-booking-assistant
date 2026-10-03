using MediatR;
using Microsoft.EntityFrameworkCore;
using SalonBooking.Application.Common;
using System.Text.Json;

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
        return salons.Select(x =>
        {
            var salonWorkers = workers.Where(w => w.SalonId == x.Id).Select(w => new WorkerDto(w.Id, w.Name, w.Active)).ToList();
            var salonServices = services.Where(s => s.SalonId == x.Id).Select(s => new ServiceDto(s.Id, s.Name, s.DurationMinutes, s.Active)).ToList();
            using var document = JsonDocument.Parse(x.ScheduleJson);
            return new SalonDto(x.Id, x.Name, x.AgentId, x.Timezone, x.ServicesJson, x.BarbersJson, x.KnowledgeNotes,
                x.ScheduleJson, x.IntegrationReady, salonServices.Select(s => s.Name).ToList(), salonWorkers.Select(w => w.Name).ToList(),
                document.RootElement.Clone(), salonWorkers, salonServices);
        }).ToList();
    }
}
