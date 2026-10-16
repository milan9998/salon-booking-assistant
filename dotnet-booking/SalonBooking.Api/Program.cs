using MediatR;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.FileProviders;
using SalonBooking.Application;
using SalonBooking.Infrastructure;
using SalonBooking.Application.Common;
using SalonBooking.Infrastructure.ElevenLabs;

var repositoryRoot = FindRepositoryRoot();
LoadDotEnv(repositoryRoot);
var builder = WebApplication.CreateBuilder(args);
builder.Configuration.AddEnvironmentVariables();
builder.Configuration["Booking:RepositoryRoot"] = repositoryRoot;
ConfigureServices(builder);

var app = builder.Build();
app.UseCors();
var publicRoot = Path.Combine(repositoryRoot, "public");
UsePublicFiles(app, publicRoot);
app.MapControllers();
MapHomePage(app, publicRoot);
app.Run();

static void ConfigureServices(WebApplicationBuilder builder)
{
    builder.Services.AddApplication();
    builder.Services.AddMediatR(typeof(SalonBooking.Application.DependencyInjection).Assembly);
    builder.Services.AddInfrastructure(builder.Configuration);
    builder.Services.AddHttpClient<IAgentProvisioner, ElevenLabsAgentProvisioner>(client => client.Timeout = TimeSpan.FromSeconds(30));
    builder.Services.AddControllers().AddJsonOptions(options =>
    {
        options.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower;
        options.JsonSerializerOptions.DictionaryKeyPolicy = JsonNamingPolicy.SnakeCaseLower;
        options.JsonSerializerOptions.Converters.Add(new TimeOnlyJsonConverter());
    });
    builder.Services.AddEndpointsApiExplorer();
    builder.Services.AddSwaggerGen();
    builder.Services.AddCors(options => options.AddDefaultPolicy(policy => policy.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));
}

static void UsePublicFiles(WebApplication app, string publicRoot)
{
    if (!Directory.Exists(publicRoot)) return;
    app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = new PhysicalFileProvider(publicRoot) });
    app.UseStaticFiles(new StaticFileOptions { FileProvider = new PhysicalFileProvider(publicRoot), ServeUnknownFileTypes = false });
}

static void MapHomePage(WebApplication app, string publicRoot)
{
    if (Directory.Exists(publicRoot) && File.Exists(Path.Combine(publicRoot, "index.html")))
        app.MapGet("/", () => Results.File(Path.Combine(publicRoot, "index.html"), "text/html; charset=utf-8"));
    else
        app.MapGet("/", () => Results.Ok(new { service = "SalonBooking .NET API", architecture = "Clean Architecture + CQRS" }));
}

static string FindRepositoryRoot()
{
    foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
        for (var directory = new DirectoryInfo(start); directory is not null; directory = directory.Parent)
            if (File.Exists(Path.Combine(directory.FullName, "elevenlabs-prompt-template.txt"))
                && Directory.Exists(Path.Combine(directory.FullName, "public"))) return directory.FullName;
    throw new InvalidOperationException("Nije pronađen koren booking projekta.");
}

static void LoadDotEnv(string repositoryRoot)
{
    var file = Path.Combine(repositoryRoot, ".env");
    if (!File.Exists(file)) return;
    foreach (var line in File.ReadLines(file)) LoadEnvironmentVariable(line);
}

static void LoadEnvironmentVariable(string line)
{
    var trimmed = line.Trim();
    if (trimmed.Length == 0 || trimmed.StartsWith('#')) return;
    var split = trimmed.IndexOf('=');
    if (split <= 0) return;
    var key = trimmed[..split].Trim();
    var value = trimmed[(split + 1)..].Trim().Trim('"');
    if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(key))) Environment.SetEnvironmentVariable(key, value);
}

public partial class Program { }

public sealed class TimeOnlyJsonConverter : JsonConverter<TimeOnly>
{
    public override TimeOnly Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => TimeOnly.Parse(reader.GetString() ?? "00:00");

    public override void Write(Utf8JsonWriter writer, TimeOnly value, JsonSerializerOptions options)
        => writer.WriteStringValue(value.ToString("HH:mm"));
}
