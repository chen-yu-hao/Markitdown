import { describe, expect, it, vi } from 'vitest';
import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';
vi.mock('electron', () => ({ Menu: {} }));
import { editorContextTemplate } from '../src/main/editor-context-menu';

const params = (patch: Partial<ContextMenuParams> = {}) => ({ isEditable: true, selectionText: 'Selected paragraph', mediaType: 'none', srcURL: '', hasImageContents: false, editFlags: { canCopy: true, canCut: true, canPaste: true }, ...patch } as ContextMenuParams);
const actions = () => ({ zh: () => true, translate: vi.fn(), copyImage: vi.fn().mockResolvedValue(undefined), error: vi.fn() });
const invoke = (item: MenuItemConstructorOptions) => (item.click as () => void)();
describe('document context menu', () => {
  it('uses native clipboard actions and the captured selection without changing document focus', () => {
    const callbacks = actions(), edit = vi.fn();
    const items = editorContextTemplate(params(), callbacks, edit);
    invoke(items.find(item => item.id === 'copy')!); invoke(items.find(item => item.id === 'paste')!); invoke(items.find(item => item.id === 'cut')!);
    expect(edit.mock.calls).toEqual([['copy'], ['paste'], ['cut']]);
    const submenu = items.find(item => item.id === 'translate')!.submenu as MenuItemConstructorOptions[];
    submenu.forEach(invoke);
    expect(callbacks.translate.mock.calls).toEqual([['Selected paragraph', 'google'], ['Selected paragraph', 'baidu']]);
  });
  it('disables edits in reading mode and selection actions without selected text', () => {
    const readonly = editorContextTemplate(params({ isEditable: false }), actions(), vi.fn());
    expect(readonly.find(item => item.id === 'copy')!.enabled).toBe(true);
    expect(readonly.find(item => item.id === 'cut')!.enabled).toBe(false);
    expect(readonly.find(item => item.id === 'paste')!.enabled).toBe(false);
    const empty = editorContextTemplate(params({ selectionText: '' }), actions(), vi.fn());
    for (const id of ['copy', 'cut', 'translate']) expect(empty.find(item => item.id === id)!.enabled).toBe(false);
  });
  it('copies only available local document images through the owner-checked callback', () => {
    const callbacks = actions(), source = 'markedown-image://document/id?src=assets%2Ffigure.png';
    const template = editorContextTemplate(params({ mediaType: 'image', srcURL: source, hasImageContents: true }), callbacks, vi.fn());
    const image = template.find(item => item.id === 'copy-image')!;
    expect(image.enabled).toBe(true); invoke(image); expect(callbacks.copyImage).toHaveBeenCalledWith(source);
    expect(editorContextTemplate(params({ mediaType: 'image', srcURL: 'https://example.com/pixel.png', hasImageContents: true }), callbacks, vi.fn())[0].enabled).toBe(false);
  });
  it('routes image settings and viewer to the captured document coordinates', () => {
    const callbacks = { ...actions(), imageAction: vi.fn() };
    const items = editorContextTemplate(params({ mediaType: 'image', srcURL: 'markedown-image://document/id?src=figure.png', x: 123, y: 456 }), callbacks, vi.fn());
    invoke(items.find(item => item.id === 'image-settings')!); invoke(items.find(item => item.id === 'image-view')!);
    expect(callbacks.imageAction.mock.calls).toEqual([['settings', 123, 456], ['view', 123, 456]]);
  });
});
