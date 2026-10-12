using Microsoft.EntityFrameworkCore;
using SalonBooking.Application.Common;
using SalonBooking.Domain.Entities;

namespace SalonBooking.Infrastructure.Persistence;

public sealed class BookingDbContext(DbContextOptions<BookingDbContext> options) : DbContext(options), IBookingDbContext
{
    public DbSet<Salon> Salons => Set<Salon>();
    public DbSet<Appointment> Appointments => Set<Appointment>();
    public DbSet<Worker> Workers => Set<Worker>();
    public DbSet<SalonService> Services => Set<SalonService>();
    public DbSet<OwnerAccount> OwnerAccounts => Set<OwnerAccount>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ConfigureSalon(modelBuilder);
        ConfigureAppointment(modelBuilder);
        ConfigureWorker(modelBuilder);
        ConfigureService(modelBuilder);
        ConfigureOwnerAccount(modelBuilder);
    }

    private static void ConfigureSalon(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Salon>(entity =>
        {
            entity.ToTable("salons");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Id).HasColumnName("id").HasMaxLength(80);
            entity.Property(x => x.Name).HasColumnName("name").IsRequired();
            entity.Property(x => x.AgentId).HasColumnName("agent_id").IsRequired();
            entity.Property(x => x.Timezone).HasColumnName("timezone").IsRequired();
            entity.Property(x => x.ServicesJson).HasColumnName("services_json").IsRequired();
            entity.Property(x => x.BarbersJson).HasColumnName("barbers_json").IsRequired();
            entity.Property(x => x.KnowledgeNotes).HasColumnName("knowledge_notes").IsRequired();
            entity.Property(x => x.CreatedAt).HasColumnName("created_at").HasColumnType("timestamp with time zone");
            entity.Property(x => x.WebhookSecretHash).HasColumnName("webhook_secret_hash");
            entity.Property(x => x.WebhookSecretId).HasColumnName("webhook_secret_id");
            entity.Property(x => x.ScheduleJson).HasColumnName("schedule_json").IsRequired();
            entity.Property(x => x.IntegrationReady).HasColumnName("integration_ready");
        });
    }

    private static void ConfigureAppointment(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Appointment>(entity =>
        {
            entity.ToTable("appointments");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Id).HasColumnName("id").HasMaxLength(40);
            entity.Property(x => x.Status).HasColumnName("status").IsRequired();
            entity.Property(x => x.SalonId).HasColumnName("salon_id").IsRequired();
            entity.Property(x => x.Date).HasColumnName("date").HasColumnType("date");
            entity.Property(x => x.Time).HasColumnName("time").HasColumnType("time without time zone");
            entity.Property(x => x.WorkerId).HasColumnName("worker_id").IsRequired();
            entity.Property(x => x.ServiceId).HasColumnName("service_id").IsRequired();
            entity.Property(x => x.CustomerName).HasColumnName("customer_name").IsRequired();
            entity.Property(x => x.Phone).HasColumnName("phone").IsRequired();
            entity.Property(x => x.CreatedAt).HasColumnName("created_at").HasColumnType("timestamp with time zone");
            entity.Property(x => x.CancelledAt).HasColumnName("cancelled_at").HasColumnType("timestamp with time zone");
            entity.Property(x => x.CancelledBy).HasColumnName("cancelled_by");
            entity.HasIndex(x => new { x.SalonId, x.Date, x.Time }).HasDatabaseName("appointments_salon_date_idx");
            entity.HasOne(x => x.Salon).WithMany(x => x.Appointments).HasForeignKey(x => x.SalonId).OnDelete(DeleteBehavior.Restrict);
            entity.HasOne(x => x.Worker).WithMany(x => x.Appointments).HasForeignKey(x => x.WorkerId).OnDelete(DeleteBehavior.Restrict);
            entity.HasOne(x => x.Service).WithMany(x => x.Appointments).HasForeignKey(x => x.ServiceId).OnDelete(DeleteBehavior.Restrict);
        });
    }

    private static void ConfigureWorker(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Worker>(entity =>
        {
            entity.ToTable("workers");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Id).HasColumnName("id").HasMaxLength(140);
            entity.Property(x => x.SalonId).HasColumnName("salon_id").IsRequired();
            entity.Property(x => x.Name).HasColumnName("name").IsRequired();
            entity.Property(x => x.Active).HasColumnName("active");
            entity.HasIndex(x => new { x.SalonId, x.Name }).IsUnique();
            entity.HasOne(x => x.Salon).WithMany(x => x.Workers).HasForeignKey(x => x.SalonId).OnDelete(DeleteBehavior.Cascade);
        });
    }

    private static void ConfigureService(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<SalonService>(entity =>
        {
            entity.ToTable("services");
            entity.HasKey(x => x.Id);
            entity.Property(x => x.Id).HasColumnName("id").HasMaxLength(140);
            entity.Property(x => x.SalonId).HasColumnName("salon_id").IsRequired();
            entity.Property(x => x.Name).HasColumnName("name").IsRequired();
            entity.Property(x => x.DurationMinutes).HasColumnName("duration_minutes");
            entity.Property(x => x.Active).HasColumnName("active");
            entity.HasIndex(x => new { x.SalonId, x.Name }).IsUnique();
            entity.HasOne(x => x.Salon).WithMany(x => x.Services).HasForeignKey(x => x.SalonId).OnDelete(DeleteBehavior.Cascade);
        });
    }

    private static void ConfigureOwnerAccount(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<OwnerAccount>(entity =>
        {
            entity.ToTable("owner_accounts");
            entity.HasKey(x => x.Username);
            entity.Property(x => x.Username).HasColumnName("username").HasMaxLength(120);
            entity.Property(x => x.SalonId).HasColumnName("salon_id").IsRequired();
            entity.Property(x => x.PasswordSalt).HasColumnName("password_salt").IsRequired();
            entity.Property(x => x.PasswordHash).HasColumnName("password_hash").IsRequired();
            entity.Property(x => x.CreatedAt).HasColumnName("created_at").HasColumnType("timestamp with time zone");
            entity.HasOne(x => x.Salon).WithMany().HasForeignKey(x => x.SalonId).OnDelete(DeleteBehavior.Restrict);
        });
    }
}
