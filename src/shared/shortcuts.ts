export const defaultShortcuts: Record<string, string> = {
  new: 'Ctrl+N', newWindow: 'Ctrl+Shift+N', open: 'Ctrl+O', workspace: 'Ctrl+Shift+O', save: 'Ctrl+S', saveAs: 'Ctrl+Shift+S',
  sidebar: 'Ctrl+Shift+L', find: 'Ctrl+F', replace: 'Ctrl+H', close: 'Ctrl+W', settings: 'Ctrl+,', mode: 'Ctrl+/', focusMode: 'F8', typewriter: 'F9',
  zoomIn: 'Ctrl+=', zoomOut: 'Ctrl+-', zoomReset: 'Ctrl+0',
  citations: 'Ctrl+Shift+C', equationReferences: 'Ctrl+Shift+R',
};
export function shortcutMatches(value: string, event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): boolean {
  const parts = value.toLowerCase().split('+'); const key = parts.pop();
  return !!key && key === event.key.toLowerCase() && parts.includes('ctrl') === (event.ctrlKey || event.metaKey) && parts.includes('alt') === event.altKey && parts.includes('shift') === event.shiftKey;
}
export function shortcutCommand(shortcuts: Record<string, string>, event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string | undefined {
  const bindings = { ...defaultShortcuts, ...shortcuts };
  return Object.keys(bindings).find(command => shortcutMatches(bindings[command], event)) || ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === '+' ? 'zoomIn' : undefined);
}
