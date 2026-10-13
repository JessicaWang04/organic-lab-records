[CmdletBinding()]
param(
    [string]$Python,
    [Alias('Host')][ValidateSet('codex', 'opencode', 'none')][string]$TargetHost = 'none',
    [switch]$InstallDependencies
)

$ErrorActionPreference = 'Stop'
$oldConsoleOutputEncoding = [Console]::OutputEncoding
$oldPipelineOutputEncoding = $OutputEncoding
try {
$labNativeUtf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $labNativeUtf8
$OutputEncoding = $labNativeUtf8
$labRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$runtimeFile = Join-Path $labRoot 'runtime.json'

function Resolve-LabExecutable {
    param([string]$Candidate)
    if ([string]::IsNullOrWhiteSpace($Candidate)) { return $null }
    if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
        return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Candidate).Path)
    }
    $command = Get-Command -Name $Candidate -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}

$requiredFiles = @('SKILL.md', 'scripts/organic-lab.cjs', 'scripts/chemistry_worker.py', 'references/tools.json')
foreach ($relativeFile in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $labRoot $relativeFile) -PathType Leaf)) {
        throw "Incomplete distribution: $relativeFile is missing. Use the built Organic Lab skill package."
    }
}

$labUserHome = $env:USERPROFILE
if ([string]::IsNullOrWhiteSpace($labUserHome)) { $labUserHome = $env:HOME }
$destination = $null
if ($TargetHost -ne 'none') {
    if ([string]::IsNullOrWhiteSpace($labUserHome) -and [string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
        throw 'Cannot resolve the user home directory for skill installation.'
    }
    if ($TargetHost -eq 'codex') {
        $codexBase = $env:CODEX_HOME
        if ([string]::IsNullOrWhiteSpace($codexBase)) { $codexBase = Join-Path $labUserHome '.codex' }
        $destination = Join-Path (Join-Path $codexBase 'skills') 'organic-lab-records'
    } else {
        if ([string]::IsNullOrWhiteSpace($labUserHome)) { throw 'Cannot resolve the user home directory for OpenCode.' }
        $destination = Join-Path (Join-Path $labUserHome '.config/opencode/skills') 'organic-lab-records'
    }
    $destination = [System.IO.Path]::GetFullPath($destination)
    if ((Test-Path -LiteralPath $destination) -and -not [System.StringComparer]::OrdinalIgnoreCase.Equals($labRoot, $destination)) {
        throw "Skill directory already exists: $destination. Existing files were preserved; update it manually after reviewing the new package."
    }
}

$bundledNode = Join-Path $labRoot 'scripts/runtime/node.exe'
$nodePath = if (Test-Path -LiteralPath $bundledNode -PathType Leaf) { $bundledNode } else { Resolve-LabExecutable 'node' }
if (-not $nodePath) { throw 'Node was not found. Use the Windows bundle with scripts/runtime/node.exe, or install Node before setup.' }
$nodeVersion = @(& $nodePath --version 2>$null)
if ($LASTEXITCODE -ne 0) { throw "Node could not start: $nodePath" }
$nodeVersionText = ($nodeVersion -join '').Trim()
if ($nodeVersionText -notmatch '^v(\d+)\.') { throw "Cannot read the Node version: $nodeVersionText" }
if ([int]$Matches[1] -lt 20) { throw "Node 20 or later is required. Found $nodeVersionText at $nodePath. Use the Windows bundle or update Node." }

$pythonProbe = @'
import contextlib, importlib, importlib.util, io, json, sys
result = {'executable': sys.executable, 'version': sys.version.split()[0], 'modules': {}, 'errors': {}}
for name in ('rdkit', 'PIL', 'pymupdf'):
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            module = importlib.import_module(name)
        result['modules'][name] = True
        if name == 'rdkit': result['rdkitVersion'] = getattr(module, '__version__', 'unknown')
    except Exception as error:
        result['modules'][name] = False
        result['errors'][name] = str(error)
result['modules']['fitz'] = importlib.util.find_spec('fitz') is not None
print(json.dumps(result))
'@

function Test-LabPython {
    param([string]$Executable, [string[]]$PrefixArguments = @())
    $previousErrorPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $lines = @(& $Executable @PrefixArguments -B -X utf8 -c $pythonProbe 2>$null)
        if ($LASTEXITCODE -ne 0) { return $null }
        return (($lines -join "`n") | ConvertFrom-Json)
    } catch { return $null }
    finally { $ErrorActionPreference = $previousErrorPreference }
}

$candidates = @()
if ($Python) {
    $explicitPython = Resolve-LabExecutable $Python
    if (-not $explicitPython) { throw "The requested Python executable was not found: $Python" }
    $candidates += @{ Executable = $explicitPython; Prefix = @() }
} else {
    if ($env:ORGANIC_LAB_PYTHON) {
        $envPython = Resolve-LabExecutable $env:ORGANIC_LAB_PYTHON
        if ($envPython) { $candidates += @{ Executable = $envPython; Prefix = @() } }
    }
    if (Test-Path -LiteralPath $runtimeFile -PathType Leaf) {
        try {
            $previous = Get-Content -LiteralPath $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $previousPython = Resolve-LabExecutable $previous.pythonPath
            if ($previousPython) { $candidates += @{ Executable = $previousPython; Prefix = @() } }
        } catch { }
    }
    foreach ($pythonName in @('python', 'python3')) {
        $foundPython = Resolve-LabExecutable $pythonName
        if ($foundPython -and $foundPython -notmatch '\\WindowsApps\\') { $candidates += @{ Executable = $foundPython; Prefix = @() } }
    }
    $pythonLauncher = Resolve-LabExecutable 'py'
    if ($pythonLauncher) { $candidates += @{ Executable = $pythonLauncher; Prefix = @('-3') } }
}

$chosen = $null
$examined = @{}
foreach ($candidate in $candidates) {
    $candidateKey = $candidate.Executable + '|' + ($candidate.Prefix -join ' ')
    if ($examined.ContainsKey($candidateKey)) { continue }
    $examined[$candidateKey] = $true
    $probe = Test-LabPython -Executable $candidate.Executable -PrefixArguments $candidate.Prefix
    if ($probe -and $probe.modules.rdkit) { $chosen = $probe; break }
}
if (-not $chosen) {
    throw 'No working RDKit Python was found. Prepare an RDKit environment and rerun setup.ps1 -Python <absolute-python-executable>. This setup does not install RDKit.'
}

$pythonPath = [System.IO.Path]::GetFullPath($chosen.executable)
$missing = @()
if (-not $chosen.modules.PIL) { $missing += 'Pillow>=10,<13' }
if (-not $chosen.modules.pymupdf) { $missing += 'PyMuPDF>=1.24,<2' }
if ($missing.Count -gt 0) {
    if (-not $InstallDependencies) {
        throw "Python is missing required packages: $($missing -join ', '). Rerun with -InstallDependencies to install only these packages into the selected Python environment."
    }
    & $pythonPath -m pip install --disable-pip-version-check @missing
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. The skill was not installed.' }
    $chosen = Test-LabPython -Executable $pythonPath
    if (-not $chosen -or -not $chosen.modules.rdkit -or -not $chosen.modules.PIL -or -not $chosen.modules.pymupdf) {
        throw 'The selected Python still cannot import RDKit, Pillow, and PyMuPDF after installation.'
    }
}

$configuration = @{ schemaVersion = 1; nodePath = [System.IO.Path]::GetFullPath($nodePath); pythonPath = $pythonPath }
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($runtimeFile, ($configuration | ConvertTo-Json), $utf8)

if ($destination -and -not [System.StringComparer]::OrdinalIgnoreCase.Equals($labRoot, $destination)) {
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    foreach ($entry in Get-ChildItem -LiteralPath $labRoot -Force) {
        Copy-Item -LiteralPath $entry.FullName -Destination $destination -Recurse
    }
    $installedConfiguration = $configuration.Clone()
    $installedBundledNode = Join-Path $destination 'scripts/runtime/node.exe'
    if (Test-Path -LiteralPath $installedBundledNode -PathType Leaf) { $installedConfiguration.nodePath = $installedBundledNode }
    [System.IO.File]::WriteAllText((Join-Path $destination 'runtime.json'), ($installedConfiguration | ConvertTo-Json), $utf8)
    Write-Output "Installed organic-lab-records: $destination"
} elseif ($destination) {
    Write-Output "This is already the installed skill directory: $destination"
}
if ($TargetHost -eq 'opencode') {
    $commandSource = Join-Path $labRoot 'assets/opencode-command/lab.md'
    if (Test-Path -LiteralPath $commandSource -PathType Leaf) {
        $commandDirectory = Join-Path $labUserHome '.config/opencode/commands'
        $commandDestination = Join-Path $commandDirectory 'lab.md'
        if (-not (Test-Path -LiteralPath $commandDestination)) {
            New-Item -ItemType Directory -Path $commandDirectory -Force | Out-Null
            Copy-Item -LiteralPath $commandSource -Destination $commandDestination
            Write-Output 'Installed OpenCode command: /lab <paper link or DOI>'
        } else {
            Write-Output "Existing /lab command preserved: $commandDestination"
        }
    }
}
Write-Output "Node: $nodePath ($($nodeVersion -join ''))"
Write-Output "Python: $pythonPath (RDKit $($chosen.rdkitVersion))"
Write-Output "Runtime configuration: $runtimeFile"
Write-Output 'Run scripts/run-lab.ps1 doctor to check the local tools.'
} finally {
    [Console]::OutputEncoding = $oldConsoleOutputEncoding
    $OutputEncoding = $oldPipelineOutputEncoding
}
