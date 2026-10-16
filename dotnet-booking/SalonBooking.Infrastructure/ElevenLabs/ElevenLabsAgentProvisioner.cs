using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using SalonBooking.Application.Common;
using SalonBooking.Domain.Entities;

namespace SalonBooking.Infrastructure.ElevenLabs;

public sealed class ElevenLabsAgentProvisioner(HttpClient client, IBookingDbContext db, IConfiguration configuration) : IAgentProvisioner
{
    private static readonly string[] ToolNames = ["check_availability", "book_appointment", "cancel_appointment"];

    public async Task ProvisionAsync(string salonId, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(configuration["ELEVENLABS_API_KEY"]))
            throw new InvalidOperationException("Nedostaje ElevenLabs API ključ na serveru.");
        var salon = await db.Salons.SingleAsync(x => x.Id == salonId, cancellationToken);
        if (await db.Salons.CountAsync(x => x.AgentId == salon.AgentId, cancellationToken) != 1)
            throw new InvalidOperationException("Isti ElevenLabs agent ne sme pripadati različitim salonima.");
        var agent = await SendAsync(HttpMethod.Get, $"agents/{salon.AgentId}", null, cancellationToken);
        var listing = await SendAsync(HttpMethod.Get, "tools?page_size=100", null, cancellationToken);
        if (listing["has_more"]?.GetValue<bool>() == true)
            throw new InvalidOperationException("Lista alata zahteva paginaciju; povezivanje je zaustavljeno.");
        var tools = listing["tools"]?.AsArray().OfType<JsonObject>().ToList() ?? [];
        var existing = tools.Where(x => Header(x, "X-Salon-Id")?.GetValue<string>() == salon.Id).ToList();
        var assigned = ToolIds(agent);
        if (assigned.Any(id => !existing.Any(x => x["id"]?.GetValue<string>() == id))
            || existing.Any(x => !ToolNames.Contains(x["tool_config"]?["name"]?.GetValue<string>())))
            throw new InvalidOperationException("Agent ima alate drugog salona ili nepoznate alate. Koristite poseban agent za ovaj salon.");

        var source = await db.Salons.AsNoTracking().FirstOrDefaultAsync(x => x.IntegrationReady && x.WebhookSecretId != null && x.Id != salonId, cancellationToken)
            ?? throw new InvalidOperationException("Nema povezanog salona sa proverenim šablonima alata.");
        var sourceAgent = await SendAsync(HttpMethod.Get, $"agents/{source.AgentId}", null, cancellationToken);
        var sourceIds = ToolIds(sourceAgent);
        var templates = ToolNames.ToDictionary(name => name, name => tools.SingleOrDefault(x =>
            sourceIds.Contains(x["id"]!.GetValue<string>()) && x["tool_config"]?["name"]?.GetValue<string>() == name
            && Header(x, "X-Salon-Id")?.GetValue<string>() == source.Id
            && Header(x, "X-Agent-Secret")?["secret_id"]?.GetValue<string>() == source.WebhookSecretId)
            ?? throw new InvalidOperationException("Nedostaju jednoznačni šabloni vezani za salon i njegovu tajnu."));
        var origins = templates.Select(x => ValidUrl(x.Value, x.Key).GetLeftPart(UriPartial.Authority)).Distinct().ToList();
        if (origins.Count != 1) throw new InvalidOperationException("Šabloni alata nemaju istu javnu adresu.");
        if (ToolNames.Any(name => existing.Count(x => x["tool_config"]?["name"]?.GetValue<string>() == name) > 1))
            throw new InvalidOperationException("Salon ima duplirane alate; povezivanje je zaustavljeno.");
        if (existing.Any(x => Header(x, "X-Agent-Secret")?["secret_id"]?.GetValue<string>() != salon.WebhookSecretId))
            throw new InvalidOperationException("Postojeći alat koristi drugačiju tajnu salona.");

        var root = configuration["Booking:RepositoryRoot"] ?? throw new InvalidOperationException("Nedostaje putanja projekta.");
        var template = await File.ReadAllTextAsync(Path.Combine(root, "elevenlabs-prompt-template.txt"), cancellationToken);
        var staff = await db.Workers.Where(x => x.SalonId == salonId && x.Active).Select(x => x.Name).ToListAsync(cancellationToken);
        var services = await db.Services.Where(x => x.SalonId == salonId && x.Active).Select(x => x.Name).ToListAsync(cancellationToken);
        if (staff.Count == 0 || services.Count == 0) throw new InvalidOperationException("Salon mora imati zaposlene i usluge.");
        salon.MarkIntegrationPending();
        await db.SaveChangesAsync(cancellationToken);
        await EnsureSecretAsync(salon, cancellationToken);

        var ids = await ProvisionToolsAsync(salon, existing, templates, origins[0], staff, services, cancellationToken);
        await ConfigureAgentAsync(salon, template, staff, services, ids, sourceAgent, cancellationToken);
        salon.MarkIntegrationReady();
        await db.SaveChangesAsync(cancellationToken);
    }

    private async Task<List<string>> ProvisionToolsAsync(Salon salon, IReadOnlyList<JsonObject> existing,
        IReadOnlyDictionary<string, JsonObject> templates, string origin, List<string> staff, List<string> services,
        CancellationToken cancellationToken)
    {
        var ids = new List<string>();
        foreach (var name in ToolNames)
        {
            var previous = existing.SingleOrDefault(x => x["tool_config"]?["name"]?.GetValue<string>() == name);
            var config = templates[name]["tool_config"]!.DeepClone();
            var schema = config["api_schema"]!;
            schema["request_headers"]!["X-Salon-Id"] = salon.Id;
            schema["request_headers"]!["X-Agent-Secret"] = new JsonObject { ["secret_id"] = salon.WebhookSecretId };
            UpdateEnum(schema, "service", services);
            UpdateEnum(schema, "barber", staff);
            var tool = await SendAsync(previous is null ? HttpMethod.Post : HttpMethod.Patch,
                previous is null ? "tools" : $"tools/{previous["id"]!.GetValue<string>()}",
                new JsonObject { ["tool_config"] = config }, cancellationToken);
            var id = tool["id"]?.GetValue<string>() ?? throw new InvalidOperationException("ElevenLabs nije vratio ID alata.");
            var verified = await SendAsync(HttpMethod.Get, $"tools/{id}", null, cancellationToken);
            if (Header(verified, "X-Salon-Id")?.GetValue<string>() != salon.Id
                || Header(verified, "X-Agent-Secret")?["secret_id"]?.GetValue<string>() != salon.WebhookSecretId
                || ValidUrl(verified, name).GetLeftPart(UriPartial.Authority) != origin)
                throw new InvalidOperationException("Nije potvrđena izolacija novog alata.");
            ids.Add(id);
        }
        return ids;
    }

    private async Task ConfigureAgentAsync(Salon salon, string template, List<string> staff, List<string> services,
        IReadOnlyList<string> ids, JsonNode sourceAgent, CancellationToken cancellationToken)
    {
        var prompt = template.Replace("NAZIV_SALONA", salon.Name).Replace("IMENA_OSOBLJA", string.Join(", ", staff))
            .Replace("USLUGE_SALONA", string.Join(", ", services.Select(SpokenService)))
            .Replace("BELEŠKE_SALONA", string.IsNullOrWhiteSpace(salon.KnowledgeNotes) ? "Nema dodatnih pravila." : salon.KnowledgeNotes);
        var first = $"Dobar dan! Dobili ste {salon.Name}. Ja sam virtuelni asistent i mogu da vam pomognem oko zakazivanja, provere ili otkazivanja termina. Šta vam je potrebno?";
        var conversation = new JsonObject
        {
            ["conversation"] = new JsonObject { ["max_duration_seconds"] = 90 },
            ["agent"] = new JsonObject
            {
                ["first_message"] = first,
                ["max_conversation_duration_message"] = "Vreme razgovora je isteklo. Hvala, prijatno.",
                ["prompt"] = new JsonObject
                {
                    ["prompt"] = prompt, ["llm"] = "gpt-4.1-mini", ["thinking_budget"] = null,
                    ["reasoning_effort"] = null, ["enable_reasoning_summary"] = false,
                    ["tool_ids"] = JsonSerializer.SerializeToNode(ids)
                }
            }
        };
        if (sourceAgent["conversation_config"]?["turn"] is { } turn) conversation["turn"] = turn.DeepClone();
        await SendAsync(HttpMethod.Patch, $"agents/{salon.AgentId}", new JsonObject { ["conversation_config"] = conversation }, cancellationToken);
        var updated = await SendAsync(HttpMethod.Get, $"agents/{salon.AgentId}", null, cancellationToken);
        var final = updated["conversation_config"]!;
        if (final["agent"]?["prompt"]?["prompt"]?.GetValue<string>() != prompt
            || final["agent"]?["first_message"]?.GetValue<string>() != first
            || final["conversation"]?["max_duration_seconds"]?.GetValue<int>() != 90
            || !ids.ToHashSet().SetEquals(ToolIds(updated)))
            throw new InvalidOperationException("Završna provera agenta nije prošla; salon još nije označen spremnim.");
    }

    private async Task EnsureSecretAsync(Salon salon, CancellationToken cancellationToken)
    {
        if (salon.WebhookSecretId is not null && salon.WebhookSecretHash is not null) return;
        var raw = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var result = await SendAsync(HttpMethod.Post, "secrets", new JsonObject
        {
            ["type"] = "new", ["name"] = $"booking_{salon.Id}_{Guid.NewGuid():N}", ["value"] = raw
        }, cancellationToken);
        var id = result["secret_id"]?.GetValue<string>() ?? throw new InvalidOperationException("ElevenLabs nije vratio ID tajne.");
        salon.SetWebhookCredentials(Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw))).ToLowerInvariant(), id);
        // Save credentials before external writes so an interrupted attempt can resume.
        await db.SaveChangesAsync(cancellationToken);
    }

    private async Task<JsonNode> SendAsync(HttpMethod method, string endpoint, JsonNode? body, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(method, "https://api.elevenlabs.io/v1/convai/" + endpoint);
        request.Headers.Add("xi-api-key", configuration["ELEVENLABS_API_KEY"]);
        if (body is not null) request.Content = JsonContent.Create(body);
        using var response = await client.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException($"ElevenLabs je vratio HTTP {(int)response.StatusCode} za {endpoint.Split('/')[0]}.");
        return await response.Content.ReadFromJsonAsync<JsonNode>(cancellationToken: cancellationToken)
            ?? throw new InvalidOperationException("ElevenLabs je vratio prazan odgovor.");
    }

    private static List<string> ToolIds(JsonNode agent) => agent["conversation_config"]?["agent"]?["prompt"]?["tool_ids"]?.AsArray()
        .Select(x => x!.GetValue<string>()).ToList() ?? [];
    private static JsonNode? Header(JsonNode tool, string name) => tool["tool_config"]?["api_schema"]?["request_headers"]?[name];
    private static Uri ValidUrl(JsonNode tool, string name)
    {
        if (!Uri.TryCreate(tool["tool_config"]?["api_schema"]?["url"]?.GetValue<string>(), UriKind.Absolute, out var uri)
            || uri.Scheme != "https" || uri.AbsolutePath != "/api/" + name.Replace('_', '-'))
            throw new InvalidOperationException("Šablon ima neispravnu webhook adresu.");
        return uri;
    }

    private static void UpdateEnum(JsonNode schema, string field, List<string> values)
    {
        if (schema["request_body_schema"]?["properties"]?[field] is { } property)
            property["enum"] = JsonSerializer.SerializeToNode(values);
    }

    private static string SpokenService(string value) => value switch
    {
        "sisanje" => "šišanje", "brada" => "sređivanje brade", "sisanje-i-brada" => "šišanje i brada", _ => value
    };
}
