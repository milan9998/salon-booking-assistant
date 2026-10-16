using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using SalonBooking.Application.Common;
using SalonBooking.Infrastructure.Persistence;

namespace SalonBooking.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection services, IConfiguration configuration)
    {
        var connection = configuration.GetConnectionString("Postgres")
            ?? configuration["POSTGRES_CONNECTION_STRING"]
            ?? throw new InvalidOperationException("POSTGRES_CONNECTION_STRING nije podešen.");
        services.AddDbContext<BookingDbContext>(options => options.UseNpgsql(connection));
        services.AddScoped<IBookingDbContext>(provider => provider.GetRequiredService<BookingDbContext>());
        services.AddScoped<IBookingTransactionRunner, BookingTransactionRunner>();
        return services;
    }
}
