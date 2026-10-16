param([int]$Port = 18787)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$apiDirectory = Join-Path $repoRoot 'dotnet-booking\SalonBooking.Api'
$apiProject = Join-Path $apiDirectory 'SalonBooking.Api.csproj'
$baseUrl = "http://127.0.0.1:$Port"

if (-not $env:POSTGRES_CONNECTION_STRING) {
    $envFile = Join-Path $repoRoot '.env'
    if (-not (Test-Path -LiteralPath $envFile)) { throw 'Nedostaje lokalni .env fajl.' }
    $connectionLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*POSTGRES_CONNECTION_STRING=' } | Select-Object -First 1
    if (-not $connectionLine) { throw 'POSTGRES_CONNECTION_STRING nije podešen u .env fajlu.' }
    $env:POSTGRES_CONNECTION_STRING = ($connectionLine -replace '^\s*POSTGRES_CONNECTION_STRING=', '').Trim().Trim('"')
}

$health = $null
try { $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 2 } catch { }
if ($health.ok -and $health.storage -eq 'postgresql') {
    Write-Output ".NET app is already running at $baseUrl (PostgreSQL salons: $($health.salons))."
    exit 0
}

$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    throw "Port $Port is used by another service. No existing process was stopped or changed."
}

$logDirectory = Join-Path $env:TEMP 'salon-booking-dotnet'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$stdout = Join-Path $logDirectory "api-$Port.out.log"
$stderr = Join-Path $logDirectory "api-$Port.err.log"
$env:ASPNETCORE_URLS = $baseUrl

$process = Start-Process -FilePath 'dotnet' `
    -ArgumentList @('run', '--project', $apiProject, '--no-launch-profile', '--urls', $baseUrl) `
    -WorkingDirectory $apiDirectory -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ($process.HasExited) { break }
    try {
        $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 2
        if ($health.ok -and $health.storage -eq 'postgresql') {
            Write-Output ".NET app is running at $baseUrl (PostgreSQL salons: $($health.salons)); PID $($process.Id)."
            Write-Output "Calendar and API: $baseUrl/"
            exit 0
        }
    } catch { }
    Start-Sleep -Milliseconds 500
}

Write-Output "App did not respond yet. Logs: $stdout and $stderr"
if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Tail 30 }
if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout -Tail 30 }
throw 'The .NET app startup was not confirmed.'
