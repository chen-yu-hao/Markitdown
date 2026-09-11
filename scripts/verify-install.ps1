param(
  [string]$InstallerPath = '',
  [switch]$Execute
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifest = Get-Content -LiteralPath (Join-Path $workspace 'package.json') -Raw | ConvertFrom-Json
if (-not $InstallerPath) { $InstallerPath = Join-Path $workspace "release\Markit-$($manifest.version)-Windows-x64-Setup.exe" }
$InstallerPath = [IO.Path]::GetFullPath($InstallerPath)
$cacheRoot = [IO.Path]::GetFullPath((Join-Path $workspace '.cache\install-smoke'))
$caseRoot = Join-Path $cacheRoot ([Guid]::NewGuid().ToString('N'))
$installDirectory = [IO.Path]::GetFullPath((Join-Path $caseRoot 'Markit'))
if (-not $installDirectory.StartsWith($cacheRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'The installation target must remain inside the project test cache.' }

function Get-RegistrySnapshot([Microsoft.Win32.RegistryHive]$Hive, [Microsoft.Win32.RegistryView]$View, [string]$RelativePath) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($Hive, $View)
  try {
    $key = $base.OpenSubKey($RelativePath, $false)
    if ($null -eq $key) { return [ordered]@{ Exists = $false; Values = @() } }
    try {
      $values = @($key.GetValueNames() | Sort-Object | ForEach-Object {
        [ordered]@{ Name = $_; Kind = $key.GetValueKind($_).ToString(); Value = $key.GetValue($_, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
      })
      return [ordered]@{ Exists = $true; Values = $values }
    } finally { $key.Dispose() }
  } finally { $base.Dispose() }
}

function Get-DefaultAssociations {
  $state = [ordered]@{}
  foreach ($extension in @('.md', '.markdown')) {
    foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
      foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
        $snapshot = Get-RegistrySnapshot $hive $view "Software\Classes\$extension"
        $state["$hive/$view/$extension"] = @($snapshot.Values)
      }
    }
    $state["UserChoice/$extension"] = Get-RegistrySnapshot CurrentUser Registry64 "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$extension\UserChoice"
  }
  return $state | ConvertTo-Json -Depth 12 -Compress
}

function Get-ExistingInstalls {
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
      try {
        $uninstall = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall', $false)
        if ($null -eq $uninstall) { continue }
        try {
          foreach ($name in $uninstall.GetSubKeyNames()) {
            $entry = $uninstall.OpenSubKey($name, $false)
            if ($null -eq $entry) { continue }
            try {
              if ($entry.GetValue('DisplayName') -eq 'Markit') {
                [ordered]@{ Hive = $hive.ToString(); View = $view.ToString(); Key = $name; InstallLocation = $entry.GetValue('InstallLocation') }
              }
            } finally { $entry.Dispose() }
          }
        } finally { $uninstall.Dispose() }
      } finally { $base.Dispose() }
    }
  }
}

function Invoke-HiddenProcess([string]$Executable, [string]$Arguments) {
  $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Hidden -PassThru
  try {
    $deadline = [DateTime]::UtcNow.AddMinutes(3)
    while (-not $process.WaitForExit(1000)) {
      if ([DateTime]::UtcNow -gt $deadline) { $process.Kill($true); $process.WaitForExit(); throw "Process did not finish within three minutes: $Executable" }
    }
    if ($process.ExitCode -ne 0) { throw "Process exited with code $($process.ExitCode): $Executable" }
  } finally { $process.Dispose() }
}

$openWithKeys = @('Software\Classes\Applications\Markit.exe', 'Software\Classes\.md\OpenWithList\Markit.exe', 'Software\Classes\.markdown\OpenWithList\Markit.exe')
$shortcuts = @((Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Markit.lnk'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'Markit.lnk'))
$existingInstalls = @(Get-ExistingInstalls)
$existingKeys = @($openWithKeys | Where-Object { (Get-RegistrySnapshot CurrentUser Registry64 $_).Exists })
$existingShortcuts = @($shortcuts | Where-Object { Test-Path -LiteralPath $_ })
$plan = [ordered]@{ Installer = $InstallerPath; InstallerPresent = (Test-Path -LiteralPath $InstallerPath -PathType Leaf); Target = $installDirectory; ExistingInstalls = $existingInstalls; ExistingKeys = $existingKeys; ExistingShortcuts = $existingShortcuts; Execute = [bool]$Execute }
$plan | ConvertTo-Json -Depth 6
if (-not $Execute) { return }
if (-not $plan.InstallerPresent) { throw 'The final installer artifact does not exist.' }
if ($existingInstalls.Count -or $existingKeys.Count -or $existingShortcuts.Count) { throw 'An existing Markit installation, association or shortcut must not be overwritten by this smoke test.' }
if (Get-Process -Name Markit -ErrorAction SilentlyContinue) { throw 'Close running Markit test windows before testing installation and uninstall.' }
foreach ($ancestor in @((Join-Path $workspace '.cache'), $cacheRoot)) {
  if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "The test cache must not redirect through a junction: $ancestor" }
}
New-Item -ItemType Directory -Path $caseRoot | Out-Null
$baseline = Get-DefaultAssociations
$report = [ordered]@{ Started = [DateTime]::UtcNow.ToString('o'); Installer = $InstallerPath; SHA256 = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash; Target = $installDirectory; Installed = $false; Uninstalled = $false; DefaultsPreserved = $false; Error = $null }
$uninstaller = Join-Path $installDirectory 'Uninstall Markit.exe'
try {
  # NSIS consumes the complete unquoted /D= tail, including spaces and Unicode.
  Invoke-HiddenProcess $InstallerPath "/S /currentuser /D=$installDirectory"
  foreach ($required in @('Markit.exe', 'Uninstall Markit.exe', 'resources\app.asar')) {
    if (-not (Test-Path -LiteralPath (Join-Path $installDirectory $required) -PathType Leaf)) { throw "Installed file is missing: $required" }
  }
  if (Test-Path -LiteralPath (Join-Path $installDirectory 'portable.json')) { throw 'The installer did not remove portable mode.' }
  foreach ($key in $openWithKeys) {
    if (-not (Get-RegistrySnapshot CurrentUser Registry64 $key).Exists) { throw "OpenWith registration is missing: $key" }
  }
  $command = Get-RegistrySnapshot CurrentUser Registry64 'Software\Classes\Applications\Markit.exe\shell\open\command'
  $expected = '"' + (Join-Path $installDirectory 'Markit.exe') + '" "%1"'
  if (($command.Values | Where-Object Name -eq '').Value -cne $expected) { throw 'The registered open command does not quote the installed application and document correctly.' }
  foreach ($shortcut in $shortcuts) { if (-not (Test-Path -LiteralPath $shortcut)) { throw "Installed shortcut is missing: $shortcut" } }
  if ((Get-DefaultAssociations) -cne $baseline) { throw 'Default Markdown associations changed during installation.' }
  $report.Installed = $true
} catch {
  $report.Error = $_.Exception.Message
} finally {
  if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
    try {
      Invoke-HiddenProcess $uninstaller '/S /currentuser'
      $deadline = [DateTime]::UtcNow.AddSeconds(90)
      while ((Test-Path -LiteralPath (Join-Path $installDirectory 'Markit.exe')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 500 }
      if (Test-Path -LiteralPath (Join-Path $installDirectory 'Markit.exe')) { throw 'The uninstaller did not remove Markit.exe.' }
      foreach ($key in $openWithKeys) { if ((Get-RegistrySnapshot CurrentUser Registry64 $key).Exists) { throw "Uninstall left an OpenWith registration: $key" } }
      foreach ($shortcut in $shortcuts) { if (Test-Path -LiteralPath $shortcut) { throw "Uninstall left a shortcut: $shortcut" } }
      if (@(Get-ExistingInstalls).Count) { throw 'Uninstall left an installed-product registry entry.' }
      $report.Uninstalled = $true
    } catch { $report.Error = (@($report.Error, $_.Exception.Message) | Where-Object { $_ }) -join '; ' }
  }
  $report.DefaultsPreserved = (Get-DefaultAssociations) -ceq $baseline
  $report.Finished = [DateTime]::UtcNow.ToString('o')
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $caseRoot 'report.json') -Encoding utf8
  $report | ConvertTo-Json -Depth 8
}
if ($report.Error -or -not $report.Installed -or -not $report.Uninstalled -or -not $report.DefaultsPreserved) { throw "Installer verification failed. See $caseRoot\report.json" }
