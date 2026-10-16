using Microsoft.Extensions.DependencyInjection;

namespace SalonBooking.Application;

public static class DependencyInjection
{
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        services.AddScoped<Appointments.BookingEligibilityService>();
        return services;
    }
}
