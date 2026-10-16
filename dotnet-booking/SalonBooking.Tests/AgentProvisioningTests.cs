using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using SalonBooking.Domain.Entities;
using SalonBooking.Infrastructure.ElevenLabs;
using Xunit;
using TestDatabase = SalonBooking.Tests.BookingConcurrencyTests.TestDatabase;

namespace SalonBooking.Tests;

public sealed class AgentProvisioningTests
{
    [PostgreSqlFact]
    public async Task Provisioning_uses_Postgres_catalog_isolates_tools_and_can_be_retried()
    {
        await using var database = await TestDatabase.CreateAsync();
        await using var db = database.CreateContext();
        var source = await db.Salons.SingleAsync();
        source.SetWebhookCredentials("source-hash", "source-secret");
        source.MarkIntegrationReady();
        var target = new Salon("new-salon", "Novi salon", "agent_new", "Europe/Belgrade", "[]", "[]", "Radi po zakazivanju", DateTime.UtcNow, null, null, "{}", false);
        db.Salons.Add(target);
        db.Workers.Add(new("new-worker", target.Id, "Jana"));
        db.Services.Add(new("new-service", target.Id, "sisanje", 30, true));
        await db.SaveChangesAsync();
        var root = Path.Combine(Path.GetTempPath(), "booking-provision-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            await File.WriteAllTextAsync(Path.Combine(root, "elevenlabs-prompt-template.txt"), "NAZIV_SALONA IMENA_OSOBLJA USLUGE_SALONA BELEŠKE_SALONA");
            var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
                { ["ELEVENLABS_API_KEY"] = "test-key", ["Booking:RepositoryRoot"] = root }).Build();
            var handler = new ElevenLabsFake();
            using var http = new HttpClient(handler);
            var service = new ElevenLabsAgentProvisioner(http, db, config);
            await service.ProvisionAsync(target.Id, default);
            Assert.True(target.IntegrationReady);
            Assert.Equal("new-secret", target.WebhookSecretId);
            Assert.NotEmpty(target.WebhookSecretHash!);
            Assert.Equal(3, handler.CreatedTools.Count);
            foreach (var tool in handler.CreatedTools)
            {
                Assert.Equal("new-salon", tool["tool_config"]!["api_schema"]!["request_headers"]!["X-Salon-Id"]!.GetValue<string>());
                Assert.Equal("new-secret", tool["tool_config"]!["api_schema"]!["request_headers"]!["X-Agent-Secret"]!["secret_id"]!.GetValue<string>());
                Assert.Equal("Jana", tool["tool_config"]!["api_schema"]!["request_body_schema"]!["properties"]!["barber"]!["enum"]![0]!.GetValue<string>());
            }
            Assert.Contains("Novi salon Jana šišanje Radi po zakazivanju", handler.Target["conversation_config"]!["agent"]!["prompt"]!["prompt"]!.GetValue<string>());
            Assert.Equal(90, handler.Target["conversation_config"]!["conversation"]!["max_duration_seconds"]!.GetValue<int>());
            await service.ProvisionAsync(target.Id, default);
            Assert.Equal(3, handler.CreatedTools.Count);
            Assert.Equal(1, handler.SecretsCreated);
        }
        finally
        {
            File.Delete(Path.Combine(root, "elevenlabs-prompt-template.txt"));
            Directory.Delete(root);
        }
    }

    [PostgreSqlFact]
    public async Task Agent_with_foreign_tools_is_rejected_before_external_writes()
    {
        await using var database = await TestDatabase.CreateAsync();
        await using var db = database.CreateContext();
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["ELEVENLABS_API_KEY"] = "test-key" }).Build();
        var fake = new ElevenLabsFake(foreign: true);
        using var http = new HttpClient(fake);
        // test-agent owns source tools whose salon header intentionally differs from this target.
        var service = new ElevenLabsAgentProvisioner(http, db, config);
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => service.ProvisionAsync("test-salon", default));
        Assert.Contains("alate", error.Message);
        Assert.Equal(0, fake.SecretsCreated);
        Assert.Empty(fake.CreatedTools);
    }

    private sealed class ElevenLabsFake : HttpMessageHandler
    {
        private static readonly string[] Names = ["check_availability", "book_appointment", "cancel_appointment"];
        public List<JsonNode> CreatedTools { get; } = [];
        public int SecretsCreated { get; private set; }
        public JsonNode Target { get; private set; } = JsonNode.Parse("{\"conversation_config\":{\"agent\":{\"prompt\":{\"tool_ids\":[]}}}}")!;
        private readonly List<JsonNode> _sources = Names.Select(CreateSource).ToList();

        private static JsonNode CreateSource(string name) => new JsonObject
        {
            ["id"] = "source-" + name,
            ["tool_config"] = new JsonObject
            {
                ["name"] = name,
                ["api_schema"] = new JsonObject
                {
                    ["url"] = "https://test.trycloudflare.com/api/" + name.Replace('_', '-'),
                    ["request_headers"] = new JsonObject
                    {
                        ["X-Salon-Id"] = "test-salon",
                        ["X-Agent-Secret"] = new JsonObject { ["secret_id"] = "source-secret" }
                    },
                    ["request_body_schema"] = JsonNode.Parse("{\"properties\":{\"service\":{\"enum\":[\"sisanje\"]},\"barber\":{\"enum\":[\"Marko\"]},\"phone\":{\"type\":\"string\"}}}")
                }
            }
        };

        public ElevenLabsFake(bool foreign = false)
        {
            if (foreign)
                foreach (var source in _sources) source["tool_config"]!["api_schema"]!["request_headers"]!["X-Salon-Id"] = "foreign-salon";
        }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Assert.Equal("api.elevenlabs.io", request.RequestUri!.Host);
            var path = request.RequestUri.AbsolutePath.Replace("/v1/convai/", "");
            JsonNode result;
            if (request.Method == HttpMethod.Get && path == "agents/test-agent")
                result = new JsonObject { ["conversation_config"] = new JsonObject
                    { ["agent"] = new JsonObject { ["prompt"] = new JsonObject { ["tool_ids"] = new JsonArray(_sources.Select(x => JsonValue.Create(x["id"]!.GetValue<string>()) as JsonNode).ToArray()) } } } };
            else if (request.Method == HttpMethod.Get && path == "agents/agent_new") result = Target.DeepClone();
            else if (request.Method == HttpMethod.Get && path == "tools")
                result = new JsonObject { ["has_more"] = false, ["tools"] = new JsonArray(_sources.Concat(CreatedTools).Select(x => x.DeepClone()).ToArray()) };
            else if (request.Method == HttpMethod.Post && path == "secrets")
            { SecretsCreated++; result = new JsonObject { ["secret_id"] = "new-secret" }; }
            else if (request.Method == HttpMethod.Post && path == "tools")
            {
                result = (await request.Content!.ReadFromJsonAsync<JsonNode>(cancellationToken: cancellationToken))!;
                result["id"] = "new-tool-" + CreatedTools.Count;
                CreatedTools.Add(result.DeepClone());
            }
            else if (request.Method == HttpMethod.Patch && path.StartsWith("tools/"))
            {
                var existing = CreatedTools.Single(x => path == "tools/" + x["id"]!.GetValue<string>());
                var body = (await request.Content!.ReadFromJsonAsync<JsonNode>(cancellationToken: cancellationToken))!;
                existing["tool_config"] = body["tool_config"]!.DeepClone();
                result = existing.DeepClone();
            }
            else if (request.Method == HttpMethod.Get && path.StartsWith("tools/"))
                result = CreatedTools.Single(x => path == "tools/" + x["id"]!.GetValue<string>()).DeepClone();
            else if (request.Method == HttpMethod.Patch && path == "agents/agent_new")
            {
                Target = (await request.Content!.ReadFromJsonAsync<JsonNode>(cancellationToken: cancellationToken))!;
                result = Target.DeepClone();
            }
            else throw new InvalidOperationException("Unexpected fake API request: " + request.Method + " " + path);
            return new(HttpStatusCode.OK) { Content = JsonContent.Create(result) };
        }
    }
}
