namespace SalonBooking.Domain.Entities;

public sealed class Worker
{
    private Worker() { }

    public Worker(string id, string salonId, string name, bool active = true)
    {
        Id = id;
        SalonId = salonId;
        Name = name;
        Active = active;
    }

    public string Id { get; private set; } = null!;
    public string SalonId { get; private set; } = null!;
    public string Name { get; private set; } = null!;
    public bool Active { get; private set; }
    public Salon Salon { get; private set; } = null!;
    public ICollection<Appointment> Appointments { get; private set; } = new List<Appointment>();
}
