namespace SalonBooking.Domain.Entities;

public sealed class Appointment
{
    private Appointment() { }

    public Appointment(string id, string status, string salonId, string workerId, string serviceId, DateOnly date, TimeOnly time,
        string customerName, string phone, DateTime createdAt, DateTime? cancelledAt, string? cancelledBy)
    {
        Id = id;
        Status = status;
        SalonId = salonId;
        WorkerId = workerId;
        ServiceId = serviceId;
        Date = date;
        Time = time;
        CustomerName = customerName;
        Phone = phone;
        CreatedAt = createdAt;
        CancelledAt = cancelledAt;
        CancelledBy = cancelledBy;
    }

    public string Id { get; private set; } = null!;
    public string Status { get; private set; } = null!;
    public string SalonId { get; private set; } = null!;
    public string WorkerId { get; private set; } = null!;
    public string ServiceId { get; private set; } = null!;
    public DateOnly Date { get; private set; }
    public TimeOnly Time { get; private set; }
    public string CustomerName { get; private set; } = null!;
    public string Phone { get; private set; } = null!;
    public DateTime CreatedAt { get; private set; }
    public DateTime? CancelledAt { get; private set; }
    public string? CancelledBy { get; private set; }
    public Salon Salon { get; private set; } = null!;
    public Worker Worker { get; private set; } = null!;
    public SalonService Service { get; private set; } = null!;

    public string Barber => Worker?.Name ?? "";
    public string ServiceName => Service?.Name ?? "";

    public bool IsConfirmed => Status == "confirmed";

    public void Cancel(string cancelledBy, DateTime cancelledAt)
    {
        Status = "cancelled";
        CancelledBy = cancelledBy;
        CancelledAt = cancelledAt;
    }
}
