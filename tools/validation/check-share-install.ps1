[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackageZip,
    [Parameter(Mandatory = $true)][string]$PythonPath,
    [Parameter(Mandatory = $true)][string]$FixtureRoot
)
$ErrorActionPreference = 'Stop'
$fixturePath = [IO.Path]::GetFullPath($FixtureRoot)
if (Test-Path -LiteralPath $fixturePath) { throw 'Use a new isolated fixture directory.' }
$fixturePrefix = $fixturePath.TrimEnd('\') + '\'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($PackageZip))
try {
    foreach ($entry in $zip.Entries) {
        $entryPath = [IO.Path]::GetFullPath((Join-Path $fixturePath $entry.FullName))
        if (-not $entryPath.StartsWith($fixturePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escaped the fixture.' }
        if ([IO.Path]::GetFileName($entry.FullName) -in @('runtime.json', 'local-defaults.json', 'data.json')) { throw 'Private configuration was included.' }
    }
} finally { $zip.Dispose() }
Expand-Archive -LiteralPath $PackageZip -DestinationPath $fixturePath
$labRoot = Join-Path $fixturePath 'organic-lab-records'
$labUserHome = Join-Path $fixturePath 'isolated-home'
$TargetHost = 'opencode'
$setupPath = Join-Path $labRoot 'setup.ps1'
$setupOutput = @(& $setupPath -Host none -Python $PythonPath)
if ($LASTEXITCODE -ne 0) { throw 'Extracted-package runtime setup failed.' }

# Execute the actual installer command-registration branch with an isolated home.
# The real USERPROFILE and OpenCode model/API settings are never changed.
$parseTokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($setupPath, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$branches = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.IfStatementAst] -and
    $node.Clauses[0].Item1.Extent.Text -eq '$TargetHost -eq ''opencode'''
}, $true))
if ($branches.Count -ne 1) { throw 'Cannot identify the OpenCode command installation branch.' }
$commandBranch = [ScriptBlock]::Create($branches[0].Extent.Text)
& $commandBranch | Out-Null
$commandFile = Join-Path $labUserHome '.config/opencode/commands/lab.md'
$commandSource = Join-Path $labRoot 'assets/opencode-command/lab.md'
if ((Get-FileHash -LiteralPath $commandFile).Hash -ne (Get-FileHash -LiteralPath $commandSource).Hash) { throw 'The new /lab command was not installed.' }
$firstWrite = (Get-Item -LiteralPath $commandFile).LastWriteTimeUtc
& $commandBranch | Out-Null
if ((Get-Item -LiteralPath $commandFile).LastWriteTimeUtc -ne $firstWrite) { throw 'Repeated installation rewrote the command.' }
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($commandFile, 'fixture user command; must remain unchanged', $utf8)
& $commandBranch | Out-Null
if ([IO.File]::ReadAllText($commandFile) -ne 'fixture user command; must remain unchanged') { throw 'An existing user command was overwritten.' }

$doctorOutput = @(& (Join-Path $labRoot 'scripts/run-lab.ps1') doctor)
if ($LASTEXITCODE -ne 0) { throw 'Doctor failed from the extracted package.' }
$doctor = ($doctorOutput -join "`n") | ConvertFrom-Json
if ($doctor.status -ne 'ready' -or $doctor.modelRequests -ne 0) { throw 'Unexpected doctor result.' }
$report = @{
    archive = [IO.Path]::GetFullPath($PackageZip)
    fixture = $fixturePath
    privateConfigurationExcluded = $true
    extractedPackageDependenciesReady = $true
    newLabCommandInstalled = $true
    repeatInstallPreservesCommand = $true
    existingUserCommandPreserved = $true
    modelRequests = 0
    fullHostLiteratureTaskTested = $false
}
[IO.File]::WriteAllText((Join-Path $fixturePath 'validation.json'), ($report | ConvertTo-Json), $utf8)
$report | ConvertTo-Json
