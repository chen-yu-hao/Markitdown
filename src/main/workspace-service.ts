import { realpath, readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { DirectoryEntry, SearchResults, Settings } from '../shared/contracts';
export type WorkspaceOptions = Pick<Settings, 'showHiddenFiles' | 'fileFilter'>;
const workspaceDefaults: WorkspaceOptions = { showHiddenFiles: false, fileFilter: 'text' };
const includeFile = (filename: string, filter: WorkspaceOptions['fileFilter']) => filter === 'all' || (textExtensions.has(path.extname(filename).toLowerCase()) && (filter !== 'markdown' || !['.txt', '.text'].includes(path.extname(filename).toLowerCase())));

const textExtensions = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdtxt', '.txt', '.text']);
const packageExtensions = new Set(['.app', '.appex', '.bundle', '.framework', '.key', '.numbers', '.pages', '.photoslibrary', '.playground', '.plugin', '.rtfd', '.xcodeproj', '.xcworkspace']);

const windowsReparseClassifier = `
using System;
using System.Runtime.InteropServices;
public static class MarkedownReparse {
  [StructLayout(LayoutKind.Sequential)] private struct AttributeTag { public uint Attributes; public uint Tag; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(IntPtr handle, int kind, out AttributeTag info, uint size);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  public static bool IsLink(string name) {
    IntPtr handle = CreateFileW(name, 0, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle == new IntPtr(-1)) return true;
    try {
      AttributeTag info;
      if (!GetFileInformationByHandleEx(handle, 9, out info, 8)) return true;
      return (info.Tag & 0x20000000) != 0;
    } finally { CloseHandle(handle); }
  }
}
`;

// Node does not expose Windows Hidden/ReparsePoint attributes. One .NET process
// scans the entire requested tree and streams results without spawning per file.
const windowsScanScript = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$extensions = @(${[...textExtensions].map(value => `'${value}'`).join(',')})
$packages = @(${[...packageExtensions].map(value => `'${value}'`).join(',')})
$reparseReady = $false
try {
  $request = ConvertFrom-Json -InputObject ([Console]::ReadLine())
  $root = [IO.Path]::GetFullPath([string]$request.root)
  if (-not [IO.Directory]::Exists($root)) { throw 'The workspace folder does not exist.' }
  $stack = New-Object 'System.Collections.Generic.Stack[string]'
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    $current = $stack.Pop()
    try { $entries = [IO.Directory]::GetFileSystemEntries($current) }
    catch { if ($current -eq $root) { throw }; continue }
    foreach ($full in $entries) {
      try {
        $name = [IO.Path]::GetFileName($full)
        if (-not $request.showHiddenFiles -and $name.StartsWith('.')) { continue }
        $attributes = [IO.File]::GetAttributes($full)
        if (-not $request.showHiddenFiles -and ($attributes -band [IO.FileAttributes]::Hidden) -ne 0) { continue }
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
          if (-not $reparseReady) {
            Add-Type -TypeDefinition @'
${windowsReparseClassifier}
'@
            $reparseReady = $true
          }
          if ([MarkedownReparse]::IsLink($full)) { continue }
        }
        $directory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
        $extension = [IO.Path]::GetExtension($full).ToLowerInvariant()
        if ($directory -and $packages.Contains($extension)) { continue }
        if ($directory -and $request.recursive) { $stack.Push($full); continue }
        $allowed = $request.fileFilter -eq 'all' -or ($extensions.Contains($extension) -and ($request.fileFilter -ne 'markdown' -or ($extension -ne '.txt' -and $extension -ne '.text')))
        if ($directory -or $allowed) {
          $entry = @{ name = $name; path = $full; directory = $directory }
          [Console]::WriteLine((ConvertTo-Json -InputObject $entry -Compress))
        }
      } catch { continue }
    }
  }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`;

async function* windowsEntries(root: string, recursive: boolean, signal?: AbortSignal, options: WorkspaceOptions = workspaceDefaults): AsyncGenerator<DirectoryEntry> {
  if (signal?.aborted) return;
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsScanScript, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let failure: Error | undefined;
  let diagnostic = '';
  child.on('error', error => { failure = error; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-8192); });
  child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') failure = error; });
  const completion = new Promise<number | null>(resolve => child.once('close', resolve));
  const cancel = () => { child.kill(); };
  signal?.addEventListener('abort', cancel, { once: true });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stdin.end(`${JSON.stringify({ root: path.resolve(root), recursive, ...options })}\n`, 'utf8');
  try {
    for await (const line of lines) {
      if (signal?.aborted) return;
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as DirectoryEntry;
      if (typeof entry.name !== 'string' || typeof entry.path !== 'string' || typeof entry.directory !== 'boolean') throw new Error('Invalid Windows directory metadata.');
      yield entry;
    }
    const code = await completion;
    if (!signal?.aborted && (failure || code !== 0)) throw new Error(`Windows workspace scan failed: ${failure?.message ?? (diagnostic.trim() || String(code))}`);
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill();
    signal?.removeEventListener('abort', cancel);
    await completion;
  }
}

export async function canonicalPath(filename: string): Promise<string> {
  const absolute = path.resolve(filename);
  let canonical: string;
  try {
    canonical = await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    canonical = parent === absolute ? absolute : path.join(await canonicalPath(parent), path.basename(absolute));
  }
  return process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical;
}

export function isWithinRoot(filename: string, root: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLocaleLowerCase('en-US') : path.resolve(value);
  const relative = path.relative(normalize(root), normalize(filename));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function listDirectory(directory: string, options: WorkspaceOptions = workspaceDefaults): Promise<DirectoryEntry[]> {
  if (packageExtensions.has(path.extname(path.resolve(directory)).toLowerCase())) throw new Error('Application and document packages cannot be used as workspaces.');
  if (process.platform === 'win32') {
    const entries: DirectoryEntry[] = [];
    for await (const entry of windowsEntries(directory, false, undefined, options)) entries.push(entry);
    return entries.sort(compareEntries);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter(entry => (options.showHiddenFiles || !entry.name.startsWith('.')) && !entry.isSymbolicLink() && (entry.isDirectory() ? !packageExtensions.has(path.extname(entry.name).toLowerCase()) : entry.isFile() && includeFile(entry.name, options.fileFilter)))
    .map(entry => ({ name: entry.name, path: path.join(directory, entry.name), directory: entry.isDirectory() }))
    .sort(compareEntries);
}

const compareEntries = (a: DirectoryEntry, b: DirectoryEntry) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

async function* workspaceDocuments(root: string, signal?: AbortSignal, options: WorkspaceOptions = workspaceDefaults): AsyncGenerator<DirectoryEntry> {
  if (process.platform === 'win32') { yield* windowsEntries(root, true, signal, options); return; }
  const directories = [path.resolve(root)];
  while (directories.length > 0) {
    if (signal?.aborted) return;
    let entries: DirectoryEntry[];
    try { entries = await listDirectory(directories.pop()!, options); } catch { continue; }
    for (const entry of entries) {
      if (signal?.aborted) return;
      if (entry.directory) directories.push(entry.path); else yield entry;
    }
  }
}

export async function searchWorkspace(root: string, query: string, caseSensitive = false, signal?: AbortSignal, options: WorkspaceOptions = workspaceDefaults): Promise<SearchResults> {
  const result: SearchResults = { hits: [], truncated: false, cancelled: false };
  if (!query) return result;
  if (signal?.aborted) return { ...result, cancelled: true };
  if (packageExtensions.has(path.extname(path.resolve(root)).toLowerCase())) throw new Error('Application and document packages cannot be used as workspaces.');
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
  const canonicalRoot = await canonicalPath(root);
  for await (const entry of workspaceDocuments(root, signal, options)) {
    if (signal?.aborted) return { ...result, cancelled: true };
    try {
      if (!isWithinRoot(await canonicalPath(entry.path), canonicalRoot)) continue;
    } catch { continue; }
    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(entry.path, { signal })).replace(/\r\n?/g, '\n');
      if (source.includes('\0')) continue;
    } catch { continue; }
    let lineStart = 0;
    let line = 1;
    expression.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(source)) !== null) {
      const offset = match.index;
      if (signal?.aborted) return { ...result, cancelled: true };
      if (result.hits.length === 500) return { ...result, truncated: true };
      for (let index = lineStart; index < offset; index++) {
        if (source[index] === '\n') { line++; lineStart = index + 1; }
      }
      const lineEnd = source.indexOf('\n', offset);
      const previewStart = Math.max(lineStart, offset - 100);
      const previewEnd = Math.min(lineEnd < 0 ? source.length : lineEnd, offset + Math.max(query.length, 180));
      result.hits.push({ path: entry.path, line, column: offset - lineStart + 1, offset, preview: source.slice(previewStart, previewEnd) });
    }
  }
  return { ...result, cancelled: signal?.aborted ?? false };
}
