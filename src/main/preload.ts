import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppEvent, MarkedownAPI } from '../shared/contracts';

const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke(`markedown:${method}`, ...args);
const api: MarkedownAPI = {
  references: { status: () => invoke('references.status'), search: query => invoke('references.search', query), cancelSearch: () => invoke('references.cancelSearch'), resolve: (source, refresh) => invoke('references.resolve', source, refresh) },
  extensions: { list: () => invoke('extensions.list') },
  bootstrap: () => invoke('bootstrap'),
  newDocument: () => invoke('newDocument'),
  newWindow: () => invoke('newWindow'),
  openFiles: paths => invoke('openFiles', paths),
  updateDocument: (id, patch) => invoke('updateDocument', id, patch),
  saveDocument: (id, patch, saveAs) => invoke('saveDocument', id, patch, saveAs),
  closeDocument: id => invoke('closeDocument', id),
  resolveExternal: (id, action) => invoke('resolveExternal', id, action),
  chooseWorkspace: path => invoke('chooseWorkspace', path),
  listDirectory: path => invoke('listDirectory', path),
  searchWorkspace: (query, caseSensitive) => invoke('searchWorkspace', query, caseSensitive),
  cancelSearch: () => invoke('cancelSearch'),
  updateSettings: settings => invoke('updateSettings', settings),
  importImages: (id, images) => invoke('importImages', id, images),
  imageURL: (id, destination) => `markedown-image://document/${encodeURIComponent(id)}?src=${encodeURIComponent(destination)}`,
  exportDocument: (id, patch, format) => invoke('exportDocument', id, patch, format),
  findPandoc: () => invoke('findPandoc'),
  choosePandoc: () => invoke('choosePandoc'),
  chooseExportFolder: () => invoke('chooseExportFolder'),
  settingsAction: action => invoke('settingsAction', action),
  handleDrop: paths => invoke('handleDrop', paths),
  importDocuments: () => invoke('importDocuments'),
  windowCommand: action => invoke('windowCommand', action),
  editCommand: action => invoke('editCommand', action),
  openExternal: url => invoke('openExternal', url),
  revealFile: path => invoke('revealFile', path),
  droppedPaths: files => files.map(file => webUtils.getPathForFile(file)).filter(Boolean),
  onEvent: listener => {
    const handler = (_event: Electron.IpcRendererEvent, event: AppEvent) => listener(event);
    ipcRenderer.on('markedown:event', handler);
    return () => ipcRenderer.removeListener('markedown:event', handler);
  },
};
contextBridge.exposeInMainWorld('markedown', api);
