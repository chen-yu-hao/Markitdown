import type { Settings } from '../shared/contracts';

/** Updating recent-file history on Save must not reconfigure CodeMirror.
 * IPC clones nested settings, so compare values rather than object identity. */
export function sameEditorSettings(previous: Settings, next: Settings): boolean {
  if (previous === next) return true;
  return (Object.keys(next) as Array<keyof Settings>).every(key =>
    key === 'recentFiles' || key === 'recentWorkspaces' ||
    previous[key] === next[key] || JSON.stringify(previous[key]) === JSON.stringify(next[key]));
}
