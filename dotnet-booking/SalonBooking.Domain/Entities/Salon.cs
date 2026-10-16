namespace SalonBooking.Domain.Entities;

public sealed class Salon
{
    private Salon() { }

    public Salon(string id, string name, string agentId, string timezone, string servicesJson, string barbersJson,
        string knowledgeNotes, DateTime createdAt, string? webhookSecretHash, string? webhookSecretId,
        string scheduleJson, bool integrationReady)
    {
        Id = id;
        Name = name;
        AgentId = agentId;
        Timezone = timezone;
        ServicesJson = servicesJson;
        BarbersJson = barbersJson;
        KnowledgeNotes = knowledgeNotes;
        CreatedAt = createdAt;
        WebhookSecretHash = webhookSecretHash;
        WebhookSecretId = webhookSecretId;
        ScheduleJson = scheduleJson;
        IntegrationReady = integrationReady;
    }

    public string Id { get; private set; } = null!;
    public string Name { get; private set; } = null!;
    public string AgentId { get; private set; } = null!;
    public string Timezone { get; private set; } = "Europe/Belgrade";
    public string ServicesJson { get; private set; } = "[]";
    public string BarbersJson { get; private set; } = "[]";
    public string KnowledgeNotes { get; private set; } = "";
    public DateTime CreatedAt { get; private set; }
    public string? WebhookSecretHash { get; private set; }
    public string? WebhookSecretId { get; private set; }
    public string ScheduleJson { get; private set; } = "{}";
    public bool IntegrationReady { get; private set; }

    public ICollection<Appointment> Appointments { get; private set; } = new List<Appointment>();
    public ICollection<Worker> Workers { get; private set; } = new List<Worker>();
    public ICollection<SalonService> Services { get; private set; } = new List<SalonService>();

    public void UpdateSchedule(string scheduleJson) => ScheduleJson = scheduleJson;
    public void UpdateKnowledge(string knowledgeNotes) => KnowledgeNotes = knowledgeNotes;
    public void UpdateProfile(string name, string servicesJson, string knowledgeNotes)
    {
        Name = name;
        ServicesJson = servicesJson;
        KnowledgeNotes = knowledgeNotes;
    }
    public void MarkIntegrationReady(string? webhookSecretId = null)
    {
        WebhookSecretId = webhookSecretId ?? WebhookSecretId;
        IntegrationReady = true;
    }

    public void SetWebhookCredentials(string hash, string secretId)
    {
        WebhookSecretHash = hash;
        WebhookSecretId = secretId;
        IntegrationReady = false;
    }

    public void MarkIntegrationPending() => IntegrationReady = false;
}
