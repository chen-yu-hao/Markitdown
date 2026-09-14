import { Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron';
import type { TranslationProvider } from '../shared/translation';

export interface ContextMenuActions {
  zh(): boolean;
  translate(text: string, provider: TranslationProvider): void;
  copyImage(url: string): Promise<void>;
  error(error: unknown): void;
}

export function editorContextTemplate(params: ContextMenuParams, actions: ContextMenuActions, edit: (action: 'cut' | 'copy' | 'paste') => void): MenuItemConstructorOptions[] {
  const t = (cn: string, en: string) => actions.zh() ? cn : en;
  const selected = !!params.selectionText?.trim();
  const items: MenuItemConstructorOptions[] = [];
  if (params.mediaType === 'image') items.push({
    id: 'copy-image', label: t('复制图片', 'Copy image'),
    enabled: params.hasImageContents && params.srcURL.startsWith('markedown-image://document/'),
    click: () => { void actions.copyImage(params.srcURL).catch(actions.error); },
  }, { type: 'separator' });
  items.push(
    { id: 'copy', label: t('复制', 'Copy'), accelerator: 'CommandOrControl+C', enabled: selected && params.editFlags.canCopy, click: () => edit('copy') },
    { id: 'paste', label: t('粘贴', 'Paste'), accelerator: 'CommandOrControl+V', enabled: params.isEditable && params.editFlags.canPaste, click: () => edit('paste') },
    { id: 'cut', label: t('剪切', 'Cut'), accelerator: 'CommandOrControl+X', enabled: params.isEditable && selected && params.editFlags.canCut, click: () => edit('cut') },
    { type: 'separator' },
    { id: 'translate', label: t('翻译', 'Translate'), enabled: selected, submenu: [
      { id: 'translate-google', label: t('Google 翻译', 'Google Translate'), click: () => actions.translate(params.selectionText, 'google') },
      { id: 'translate-baidu', label: t('百度翻译', 'Baidu Translate'), click: () => actions.translate(params.selectionText, 'baidu') },
    ] },
  );
  return items;
}

export function installEditorContextMenu(win: BrowserWindow, actions: ContextMenuActions) {
  win.webContents.on('context-menu', (_event, params) => {
    // Built-in controls outside document text keep their own menus.
    if (!params.isEditable && !params.selectionText && params.mediaType !== 'image') return;
    Menu.buildFromTemplate(editorContextTemplate(params, actions, action => win.webContents[action]())).popup({ window: win });
  });
}
