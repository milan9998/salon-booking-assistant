namespace SalonBooking.Domain.Entities;

public sealed class OwnerAccount
{
    private OwnerAccount() { }

    public OwnerAccount(string username, string salonId, string passwordSalt, string passwordHash, DateTime createdAt)
    {
        Username = username;
        SalonId = salonId;
        PasswordSalt = passwordSalt;
        PasswordHash = passwordHash;
        CreatedAt = createdAt;
    }

    public string Username { get; private set; } = null!;
    public string SalonId { get; private set; } = null!;
    public string PasswordSalt { get; private set; } = null!;
    public string PasswordHash { get; private set; } = null!;
    public DateTime CreatedAt { get; private set; }
    public Salon Salon { get; private set; } = null!;

    public void ChangePassword(string salt, string hash)
    {
        PasswordSalt = salt;
        PasswordHash = hash;
    }
}
