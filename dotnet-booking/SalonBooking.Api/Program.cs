using MediatR;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.FileProviders;
using SalonBooking.Application;
using SalonBooking.Infrastructure;

LoadDotEnv();
var builder = WebApplication.CreateBuilder(args);
builder.Configuration.AddEnvironmentVariables();
builder.Services.AddApplication();
builder.Services.AddMediatR(typeof(SalonBooking.Application.DependencyInjection).Assembly);
builder.Services.AddInfrastructure(builder.Configuration);
builder.Services.AddControllers().AddJsonOptions(options =>
{
    options.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower;
    options.JsonSerializerOptions.DictionaryKeyPolicy = JsonNamingPolicy.SnakeCaseLower;
    options.JsonSerializerOptions.Converters.Add(new TimeOnlyJsonConverter());
});
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
builder.Services.AddCors(options => options.AddDefaultPolicy(policy => policy.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();
app.UseCors();
var publicRoot = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "..", "..", "public"));
if (Directory.Exists(publicRoot))
{
    app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = new PhysicalFileProvider(publicRoot) });
    app.UseStaticFiles(new StaticFileOptions { FileProvider = new PhysicalFileProvider(publicRoot), ServeUnknownFileTypes = false });
}
app.MapControllers();
if (Directory.Exists(publicRoot) && File.Exists(Path.Combine(publicRoot, "index.html")))
    app.MapGet("/", () => Results.File(Path.Combine(publicRoot, "index.html"), "text/html; charset=utf-8"));
else
    app.MapGet("/", () => Results.Ok(new { service = "SalonBooking .NET API", architecture = "Clean Architecture + CQRS" }));
app.Run();

static void LoadDotEnv()
{
    var file = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "..", "..", ".env"));
    if (!File.Exists(file)) return;
    foreach (var line in File.ReadLines(file))
    {
        var trimmed = line.Trim();
        if (trimmed.Length == 0 || trimmed.StartsWith('#')) continue;
        var split = trimmed.IndexOf('=');
        if (split <= 0) continue;
        var key = trimmed[..split].Trim();
        var value = trimmed[(split + 1)..].Trim().Trim('"');
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(key))) Environment.SetEnvironmentVariable(key, value);
    }
}

public partial class Program { }

public sealed class TimeOnlyJsonConverter : JsonConverter<TimeOnly>
{
    public override TimeOnly Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => TimeOnly.Parse(reader.GetString() ?? "00:00");

    public override void Write(Utf8JsonWriter writer, TimeOnly value, JsonSerializerOptions options)
        => writer.WriteStringValue(value.ToString("HH:mm"));
}
