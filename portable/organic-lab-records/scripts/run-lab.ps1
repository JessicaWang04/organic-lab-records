[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$LabArguments)

$ErrorActionPreference = 'Stop'
$labRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeFile = Join-Path $labRoot 'runtime.json'
$configuration = $null
if (Test-Path -LiteralPath $runtimeFile -PathType Leaf) {
    try { $configuration = Get-Content -LiteralPath $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw 'runtime.json cannot be read. Rerun setup.ps1 for this package.' }
}
$bundledNode = Join-Path $labRoot 'scripts/runtime/node.exe'
$nodePath = $null
if (Test-Path -LiteralPath $bundledNode -PathType Leaf) { $nodePath = $bundledNode }
elseif ($configuration -and $configuration.nodePath -and (Test-Path -LiteralPath $configuration.nodePath -PathType Leaf)) { $nodePath = $configuration.nodePath }
else {
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nodeCommand) { $nodePath = $nodeCommand.Source }
}
if (-not $nodePath) { throw 'Node was not found. Run setup.ps1 or use a distribution containing scripts/runtime/node.exe.' }
$cliPath = Join-Path $labRoot 'scripts/organic-lab.cjs'
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) { throw 'The compiled scripts/organic-lab.cjs is missing. Use the built skill package.' }

$oldPython = $env:ORGANIC_LAB_PYTHON
$oldConsoleOutputEncoding = [Console]::OutputEncoding
$oldPipelineOutputEncoding = $OutputEncoding
try {
    $labNativeUtf8 = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $labNativeUtf8
    $OutputEncoding = $labNativeUtf8
    if (-not $env:ORGANIC_LAB_PYTHON -and $configuration -and $configuration.pythonPath) { $env:ORGANIC_LAB_PYTHON = $configuration.pythonPath }
    & $nodePath $cliPath @LabArguments
    $commandExitCode = $LASTEXITCODE
} finally {
    [Console]::OutputEncoding = $oldConsoleOutputEncoding
    $OutputEncoding = $oldPipelineOutputEncoding
    if ($null -eq $oldPython) { Remove-Item Env:ORGANIC_LAB_PYTHON -ErrorAction SilentlyContinue }
    else { $env:ORGANIC_LAB_PYTHON = $oldPython }
}
exit $commandExitCode
