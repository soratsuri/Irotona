[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')]
  [string]$Version,

  [Parameter(Mandatory)]
  [string]$Destination
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$destinationPath = [IO.Path]::GetFullPath($Destination, $repoRoot)
if (Test-Path -LiteralPath $destinationPath) {
  throw 'Choose a new staging directory to keep previous builds and settings intact.'
}

$targetDir = if ($env:CARGO_TARGET_DIR) {
  [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR, $repoRoot)
} else {
  Join-Path $repoRoot 'src-tauri/target'
}
$binary = Join-Path $targetDir 'release/luma-palette-csp.exe'
$binaryInfo = Get-Item -LiteralPath $binary
if ($binaryInfo.VersionInfo.ProductVersion -ne $Version) {
  throw "Built executable version does not match $Version."
}

$bytes = [IO.File]::ReadAllBytes($binary)
if ($bytes.Length -lt 64 -or [BitConverter]::ToUInt16($bytes, 0) -ne 0x5A4D) {
  throw 'Expected a Windows executable.'
}
$peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
if ($peOffset -lt 64 -or $peOffset -gt ($bytes.Length - 6) -or
    [BitConverter]::ToUInt32($bytes, $peOffset) -ne 0x4550 -or
    [BitConverter]::ToUInt16($bytes, $peOffset + 4) -ne 0x8664) {
  throw 'Expected a Windows x64 executable.'
}
$localPath = '(?i)[a-z]:[\\/]+(?:users|documents and settings)[\\/]'
foreach ($encoding in @([Text.Encoding]::ASCII, [Text.Encoding]::Unicode)) {
  $contents = $encoding.GetString($bytes)
  if ($contents -match $localPath -or $contents.Contains($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The executable contains a local path. Rebuild using the path remapping in RELEASING.md.'
  }
}

Push-Location -LiteralPath $repoRoot
try {
  $previousNativeCommandPreference = $PSNativeCommandUseErrorActionPreference
  $PSNativeCommandUseErrorActionPreference = $false
  try {
    $statusOutput = @(git status --porcelain --untracked-files=all 2>&1)
    $statusExitCode = $LASTEXITCODE
  } finally {
    $PSNativeCommandUseErrorActionPreference = $previousNativeCommandPreference
  }

  if ($statusExitCode -ne 0) {
    $statusDetails = ($statusOutput | Out-String).Trim()
    throw "git status failed with exit code $statusExitCode. $statusDetails"
  }
  if ($statusOutput.Count -gt 0) {
    $previousNativeCommandPreference = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
    try {
      $diffOutput = @(git diff --quiet HEAD -- 2>&1)
      $diffExitCode = $LASTEXITCODE
      $untrackedOutput = @(git ls-files --others --exclude-standard 2>&1)
      $untrackedExitCode = $LASTEXITCODE
    } finally {
      $PSNativeCommandUseErrorActionPreference = $previousNativeCommandPreference
    }
    if ($diffExitCode -eq 0 -and $untrackedExitCode -eq 0 -and $untrackedOutput.Count -eq 0) {
      Write-Host 'Git status reported changes, but the worktree matches HEAD and has no untracked files.'
    } else {
      $diffDetails = "git diff exit code: $diffExitCode`n$($diffOutput -join [Environment]::NewLine)`ngit ls-files exit code: $untrackedExitCode`n$($untrackedOutput -join [Environment]::NewLine)"
      throw "Stage from a clean checkout so the archive matches the binary source:`n$($statusOutput -join [Environment]::NewLine)`n$diffDetails"
    }
  }

  $metadataJson = cargo metadata --manifest-path src-tauri/Cargo.toml --locked --offline --format-version 1 --filter-platform x86_64-pc-windows-msvc
  if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the locked Windows build dependencies.' }
  $metadata = $metadataJson | ConvertFrom-Json
  $appPackage = $metadata.packages | Where-Object { $_.id -eq $metadata.resolve.root }
  if ($appPackage.version -ne $Version) { throw 'Source version does not match the executable.' }
  $dependencies = $metadata.packages | Where-Object source | Sort-Object name, version

  $crateFiles = foreach ($package in $dependencies) {
    if ($package.source -ne 'registry+https://github.com/rust-lang/crates.io-index' -or -not $package.license) {
      throw "Review the source and licensing of $($package.name) $($package.version) before staging."
    }

    $registrySource = (Get-Item -LiteralPath $package.manifest_path).Directory.Parent
    $registry = $registrySource.Parent.Parent.FullName
    $crateName = "$($package.name)-$($package.version).crate"
    $cratePath = Join-Path $registry "cache/$($registrySource.Name)/$crateName"
    Get-Item -LiteralPath $cratePath
  }

  New-Item -ItemType Directory -Path $destinationPath | Out-Null
  $sourceZip = Join-Path $destinationPath "Irotona-$Version-source.zip"
  git -c core.autocrlf=false archive --format=zip --prefix=app/ "--output=$sourceZip" HEAD -- LICENSE NOTICE README.md README.ja.md RELEASING.md PROTOCOL.md package.json package-lock.json src src-tauri scripts tests .github/workflows
  if ($LASTEXITCODE -ne 0) { throw 'Could not archive the committed application source.' }

  $zip = [IO.Compression.ZipFile]::Open($sourceZip, [IO.Compression.ZipArchiveMode]::Update)
  try {
    foreach ($file in $crateFiles) {
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip, $file.FullName, "rust-crates/$($file.Name)", [IO.Compression.CompressionLevel]::NoCompression
      ) | Out-Null
    }

    $entry = $zip.CreateEntry('rust-dependencies.tsv')
    $writer = [IO.StreamWriter]::new($entry.Open())
    try {
      $writer.WriteLine("Name$([char]9)Version$([char]9)Declared license")
      foreach ($package in $dependencies) {
        $writer.WriteLine((@($package.name, $package.version, $package.license) -join [char]9))
      }
    } finally {
      $writer.Dispose()
    }
  } finally {
    $zip.Dispose()
  }

  Copy-Item -LiteralPath $binary -Destination (Join-Path $destinationPath 'Irotona.exe')
  Copy-Item -LiteralPath 'LICENSE', 'NOTICE' -Destination $destinationPath
  Get-ChildItem -LiteralPath $destinationPath -File | Sort-Object Name | ForEach-Object {
    '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name
  } | Set-Content -LiteralPath (Join-Path $destinationPath 'SHA256SUMS.txt') -Encoding ascii
} finally {
  Pop-Location
}

Write-Output $destinationPath
