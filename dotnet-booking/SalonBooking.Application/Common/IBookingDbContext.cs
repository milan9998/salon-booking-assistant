using Microsoft.EntityFrameworkCore;
using SalonBooking.Domain.Entities;

namespace SalonBooking.Application.Common;

public interface IBookingDbContext
{
    DbSet<Salon> Salons { get; }
    DbSet<Appointment> Appointments { get; }
    DbSet<Worker> Workers { get; }
    DbSet<SalonService> Services { get; }
    DbSet<OwnerAccount> OwnerAccounts { get; }
    Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);
}
