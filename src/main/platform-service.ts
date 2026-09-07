import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import type { Settings } from '../shared/contracts';
import { themeTokens } from '../shared/themes';
import path from 'node:path';

/** Windows access(W_OK) does not test ACL write permissions; exercise an actual private file. */
export async function assertWritableDataDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const probe = path.join(path.resolve(directory), `.markedown-write-probe-${randomUUID()}.tmp`);
  const handle = await open(probe, 'wx');
  try {
    try { await handle.writeFile('Markedown'); await handle.sync(); }
    finally { await handle.close(); }
  } finally { await unlink(probe); }
}

export function resolvedTheme(settings: Settings, dark: boolean) { return settings.separateDarkTheme && dark ? settings.darkTheme : settings.theme; }
export function titleBarColors(settings: Settings, dark: boolean) {
  const theme = resolvedTheme(settings, dark);
  const tokens = themeTokens[theme];
  return { color: tokens.chrome, symbolColor: tokens.ink, height: Math.round(36 * settings.zoom / 100) };
}
export const exportExtensions: Record<string, string> = { htmlPlain: 'html', html: 'html', pdf: 'pdf', png: 'png', docx: 'docx', epub: 'epub', tex: 'tex', rtf: 'rtf', odt: 'odt', mediawiki: 'wiki', rst: 'rst', textile: 'textile', opml: 'opml' };
export function validExportFormat(format: unknown): format is Settings['exportPresets'][number]['format'] { return typeof format === 'string' && Object.hasOwn(exportExtensions, format); }
export function newDocumentFilename(title: string, settings: Pick<Settings, 'defaultExtension'>) { return `${title.replace(/\.(?:md|markdown|txt)$/i, '')}.${settings.defaultExtension}`; }
export function recentPaths(previous: string[], next: string, maximum = 30) {
  const identity = (value: string) => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
  return [next, ...previous.filter(value => identity(value) !== identity(next))].slice(0, maximum);
}

// Only our tagged ShellNew entries can be removed. Existing registrations remain intact.
export async function setNewFileRegistration(enabled: boolean): Promise<{ changed: number; preserved: number }> {
  if (process.platform !== 'win32') throw new Error('Explorer New-file registration is only available on Windows.');
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $request = ConvertFrom-Json -InputObject ([Console]::ReadLine())
  $changed = 0
  $preserved = 0
  foreach ($extension in @('.md','.markdown')) {
    $relative = 'Software\\Classes\\' + $extension + '\\ShellNew'
    $existing = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($relative, $true)
    if ($request.enabled) {
      if ($existing -and $existing.GetValue('MarkedownOwner') -ne 'Markedown') { $existing.Close(); $preserved++; continue }
      if (-not $existing) { $existing = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($relative) }
      $existing.SetValue('NullFile', '')
      $existing.SetValue('MarkedownOwner', 'Markedown')
      $existing.Close()
      $changed++
    } elseif ($existing) {
      $owned = $existing.GetValue('MarkedownOwner') -eq 'Markedown'
      if ($owned) {
        $existing.DeleteValue('NullFile', $false)
        $existing.DeleteValue('MarkedownOwner', $false)
        $empty = $existing.ValueCount -eq 0 -and $existing.SubKeyCount -eq 0
        $changed++
      }
      $existing.Close()
      if ($owned -and $empty) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($relative, $false) }
    }
  }
  if ($changed -gt 0) {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MarkedownShellNotification { [DllImport("shell32.dll")] public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr first, IntPtr second); }'
    [MarkedownShellNotification]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
  }
  [Console]::WriteLine((ConvertTo-Json -Compress -InputObject @{ changed = $changed; preserved = $preserved }))
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`;
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let diagnostic = ''; let error: Error | undefined;
  child.on('error', failure => { error = failure; });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4096); });
  child.stdin.on('error', () => undefined);
  child.stdin.end(`${JSON.stringify({ enabled })}\n`);
  const timeout = setTimeout(() => child.kill(), 10000);
  try {
    const code = await new Promise<number | null>(resolve => child.once('close', resolve));
    if (error || code !== 0) throw new Error(error?.message || diagnostic || 'Windows registration failed or timed out.');
    const result = JSON.parse(output.trim()) as { changed: number; preserved: number };
    if (!Number.isSafeInteger(result.changed) || !Number.isSafeInteger(result.preserved) || result.changed < 0 || result.changed > 2 || result.preserved < 0 || result.preserved > 2) throw new Error('Windows registration returned an invalid result.');
    return result;
  } finally { clearTimeout(timeout); }
}
