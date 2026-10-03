using MediatR;
using Microsoft.EntityFrameworkCore;
using SalonBooking.Application.Common;

namespace SalonBooking.Application.Appointments;

public sealed record AppointmentDto(string Id, string Status, string SalonId, DateOnly Date, TimeOnly Time, string Service,
    string Barber, string CustomerName, string Phone, DateTime CreatedAt, DateTime? CancelledAt, string? CancelledBy,
    string WorkerId, string ServiceId);

public sealed record GetAppointmentsQuery(string SalonId) : IRequest<IReadOnlyList<AppointmentDto>>;

public sealed class GetAppointmentsQueryHandler(IBookingDbContext db) : IRequestHandler<GetAppointmentsQuery, IReadOnlyList<AppointmentDto>>
{
    public async Task<IReadOnlyList<AppointmentDto>> Handle(GetAppointmentsQuery request, CancellationToken cancellationToken)
        => await db.Appointments.AsNoTracking().Where(x => x.SalonId == request.SalonId).OrderBy(x => x.Date).ThenBy(x => x.Time)
            .Select(x => new AppointmentDto(x.Id, x.Status, x.SalonId, x.Date, x.Time, x.Service.Name, x.Worker.Name,
                x.CustomerName, x.Phone, x.CreatedAt, x.CancelledAt, x.CancelledBy, x.WorkerId, x.ServiceId))
            .ToListAsync(cancellationToken);
}
