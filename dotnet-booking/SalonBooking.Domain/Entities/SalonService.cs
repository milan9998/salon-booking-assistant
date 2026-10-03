namespace SalonBooking.Domain.Entities;

public sealed class SalonService
{
    private SalonService() { }

    public SalonService(string id, string salonId, string name, int durationMinutes, bool active = true)
    {
        Id = id;
        SalonId = salonId;
        Name = name;
        DurationMinutes = durationMinutes;
        Active = active;
    }

    public string Id { get; private set; } = null!;
    public string SalonId { get; private set; } = null!;
    public string Name { get; private set; } = null!;
    public int DurationMinutes { get; private set; }
    public bool Active { get; private set; }
    public Salon Salon { get; private set; } = null!;
    public ICollection<Appointment> Appointments { get; private set; } = new List<Appointment>();

    public void SetActive(bool active) => Active = active;
}
