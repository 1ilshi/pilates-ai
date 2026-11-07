<#
.SYNOPSIS
    Sign a built Windows installer and keep the updater signature valid.

.DESCRIPTION
    Tauri writes the updater signature (`*.exe.sig`) over the installer bytes.
    Signing the installer *afterwards* changes those bytes, so the `.sig` no
    longer matches and every client rejects the update — silently, because the
    check happens at install time on the clinic's machine, not here.

    This script therefore:
      1. signs the installer,
      2. regenerates its `.sig` with the updater key,
      3. rebuilds `latest.json` / `channel.json`,
    so the manifest that gets published always describes the signed bytes.

    If you would rather Tauri did all of this during bundling, set
    `bundle.windows.certificateThumbprint` and `timestampUrl` in
    `tauri.windows.conf.json` instead — that ordering is correct by
    construction and this script is then unnecessary.

.PARAMETER Installer
    Path to the NSIS installer, e.g.
    apps\desktop\src-tauri\target\release\bundle\nsis\Pilates AI_2.0.0_x64-setup.exe

.PARAMETER Pfx
    Path to a .pfx/.p12 certificate. Omit to use a certificate already in the
    Windows certificate store (then pass -Thumbprint).

.PARAMETER Thumbprint
    SHA-1 thumbprint of a certificate in the current user's store.

.PARAMETER TimestampUrl
    RFC 3161 timestamp server. Defaults to DigiCert's.

.EXAMPLE
    .\tools\sign-windows.ps1 -Installer "apps\desktop\src-tauri\target\release\bundle\nsis\Pilates AI_2.0.0_x64-setup.exe" -Pfx C:\certs\pilates.pfx
#>
[CmdletBinding(DefaultParameterSetName = 'Pfx')]
param(
    [Parameter(Mandatory = $true)]
    [string]$Installer,

    [Parameter(Mandatory = $true, ParameterSetName = 'Pfx')]
    [string]$Pfx,

    [Parameter(Mandatory = $false, ParameterSetName = 'Pfx')]
    [string]$PfxPassword,

    [Parameter(Mandatory = $true, ParameterSetName = 'Store')]
    [string]$Thumbprint,

    [string]$TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'

function Find-SignTool {
    $onPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    $roots = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
        "$env:ProgramFiles\Windows Kits\10\bin"
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        $candidate = Get-ChildItem $root -Directory |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
        if ($candidate) { return $candidate }
    }
    throw 'signtool.exe not found. Install the Windows SDK, or add signtool to PATH.'
}

if (-not (Test-Path $Installer)) { throw "installer not found: $Installer" }

$signtool = Find-SignTool
$installerPath = (Resolve-Path $Installer).Path
$sigPath = "$installerPath.sig"

Write-Host "signing   : $installerPath"
Write-Host "signtool  : $signtool"

# The old signature describes the unsigned bytes. Remove it first so a failure
# below cannot leave a stale, misleading .sig behind.
if (Test-Path $sigPath) {
    Remove-Item $sigPath -Force
    Write-Host 'removed the previous updater signature (it described unsigned bytes)'
}

if ($PSCmdlet.ParameterSetName -eq 'Pfx') {
    if (-not (Test-Path $Pfx)) { throw "certificate not found: $Pfx" }
    & $signtool sign /fd SHA256 /f $Pfx /p $PfxPassword /tr $TimestampUrl /td SHA256 $installerPath
} else {
    & $signtool sign /fd SHA256 /sha1 $Thumbprint /tr $TimestampUrl /td SHA256 $installerPath
}
if ($LASTEXITCODE -ne 0) { throw "signtool sign failed with exit code $LASTEXITCODE" }

& $signtool verify /pa /v $installerPath | Out-Host
if ($LASTEXITCODE -ne 0) { throw "signature verification failed with exit code $LASTEXITCODE" }

# Regenerate the updater signature over the now-signed bytes.
$key = Join-Path $env:USERPROFILE '.tauri\pilates-updater.key'
if (-not (Test-Path $key)) {
    Write-Warning "updater key not found at $key - the .sig was NOT regenerated."
    Write-Warning 'Run `pnpm tauri signer sign` against the installer before publishing.'
    return
}

$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $key -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
Push-Location (Join-Path $PSScriptRoot '..')
try {
    corepack pnpm --filter @pilates/desktop exec tauri signer sign $installerPath
    if ($LASTEXITCODE -ne 0) { throw 'tauri signer sign failed' }
} finally {
    Pop-Location
}

# Stage the installer, its fresh signature, and rebuilt manifests together.
$staging = Join-Path $PSScriptRoot '..\release-assets'
New-Item -ItemType Directory -Force -Path $staging | Out-Null
Copy-Item $installerPath $staging -Force
Copy-Item $sigPath $staging -Force
node (Join-Path $PSScriptRoot 'build-update-manifest.mjs') $staging

Write-Host ''
Write-Host "signed and re-manifested. Publish $staging to the release:" -ForegroundColor Green
Write-Host "  gh release upload <tag> $staging\* --clobber"
