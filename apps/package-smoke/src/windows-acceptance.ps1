param(
    [Parameter(Mandatory)]
    [string] $PackagePath
)

$ErrorActionPreference = 'Stop'
$package = (Resolve-Path -LiteralPath $PackagePath).Path
$source = Join-Path $package 'chatgpt-tela.exe'
$localRoot = Join-Path $env:LOCALAPPDATA 'ChatGPT Tela'
$roamingRoot = Join-Path $env:APPDATA 'ChatGPT Tela'
$installed = Join-Path $localRoot 'bin\chatgpt-tela.exe'
$config = Join-Path $roamingRoot 'product-v1.json'
$taskNames = @('ChatGPTTelaGateway', 'ChatGPTTelaChat', 'ChatGPTTelaCodex')

function Get-TelaTask([string] $Name) {
    Get-ScheduledTask -TaskPath '\' -TaskName $Name -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or
    (Test-Path -LiteralPath $localRoot) -or (Test-Path -LiteralPath $roamingRoot)) {
    throw 'Use the extracted package in a disposable Windows profile without an existing Tela installation.'
}
foreach ($name in $taskNames) {
    if (Get-TelaTask $name) { throw "Reserved task already exists: $name" }
}

function Invoke-Tela([string] $Launcher, [string[]] $CommandArguments) {
    $lines = & $Launcher @CommandArguments
    if ($LASTEXITCODE -ne 0) { throw "Tela command failed: $($CommandArguments -join ' ')" }
    return ($lines -join "`n") | ConvertFrom-Json
}

function Install-TelaPackage {
    $result = Invoke-Tela $source @('install', '--apply')
    if (-not $result.verify.ready) { throw 'The package did not verify after installation.' }
    foreach ($name in $taskNames) {
        $task = Get-TelaTask $name
        if (-not $task -or $task.State.ToString() -ne 'Ready' -or
            $task.Actions.Execute -ine $installed -or $task.Triggers -or
            $task.Principal.LogonType.ToString() -ne 'Interactive' -or
            $task.Settings.ExecutionTimeLimit -ne 'PT0S' -or
            $task.Settings.DisallowStartIfOnBatteries -or $task.Settings.StopIfGoingOnBatteries) {
            throw "Scheduled task differs from its package definition: $name"
        }
    }
}

function Assert-TelaRemoved {
    if ((Test-Path -LiteralPath $installed) -or (Get-Content -LiteralPath $sentinel -Raw) -cne 'outside Tela') {
        throw 'Tela binary removal or unrelated-file preservation failed.'
    }
    foreach ($name in $taskNames) {
        if (Get-TelaTask $name) { throw "Scheduled task remains after removal: $name" }
    }
}

$sentinel = (New-TemporaryFile).FullName
try {
    Set-Content -LiteralPath $sentinel -Value 'outside Tela' -NoNewline
    Install-TelaPackage
    '{"version":1,"publicMcpAbi":"stable","exposure":{"kind":"existing-https","publicUrl":"https://example.test/mcp","localPort":18743,"authentication":"none","allowUnauthenticatedPublicEndpoint":true}}' |
        & $installed configure --stdin --if-missing
    if ($LASTEXITCODE -ne 0) { throw 'Tela setup failed.' }
    $configHash = (Get-FileHash -LiteralPath $config).Hash

    $start = Invoke-Tela $installed @('services', 'start', 'chat')
    if (-not $start.success -or (Get-TelaTask 'ChatGPTTelaChat').State.ToString() -ne 'Running') {
        throw 'The packaged Chat service did not start.'
    }
    $stop = Invoke-Tela $installed @('services', 'stop', 'chat')
    if (-not $stop.success -or (Get-TelaTask 'ChatGPTTelaChat').State.ToString() -ne 'Ready') {
        throw 'The packaged Chat service did not stop.'
    }

    Remove-Item -LiteralPath $installed
    $repair = Invoke-Tela $source @('repair', '--apply')
    if ($repair.payload -ne 'repaired' -or
        (Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $installed).Hash) {
        throw 'Package repair did not restore the missing launcher.'
    }

    $remove = Invoke-Tela $source @('uninstall', '--apply')
    if (-not $remove.applied -or $remove.failedCount -ne 0) { throw 'Keep-data removal failed.' }
    Assert-TelaRemoved
    Install-TelaPackage
    if ((Get-FileHash -LiteralPath $config).Hash -ne $configHash) { throw 'Reinstall changed the retained configuration.' }

    $remove = Invoke-Tela $source @('uninstall', '--apply', '--remove-data')
    if (-not $remove.applied -or $remove.failedCount -ne 0 -or -not $remove.manifestRemoved) {
        throw 'Full removal failed.'
    }
    Assert-TelaRemoved
    if (Test-Path -LiteralPath $config) { throw 'Full removal kept the Tela configuration.' }
} finally {
    Remove-Item -LiteralPath $sentinel
}
