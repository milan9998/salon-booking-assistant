namespace SalonBooking.Application.Common;

public interface IAgentProvisioner
{
    Task ProvisionAsync(string salonId, CancellationToken cancellationToken);
}
