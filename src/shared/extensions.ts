import type MarkdownIt from 'markdown-it';
import type { ReferenceProvider } from './academic-contracts';

export const EXTENSION_API_VERSION = 1 as const;
export type ExtensionCapability = 'markdown' | 'references';
export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: typeof EXTENSION_API_VERSION;
  capabilities: readonly ExtensionCapability[];
}
export interface ExtensionContribution {
  manifest: ExtensionManifest;
  markdown?: (parser: ReturnType<typeof MarkdownIt>) => void;
  references?: ReferenceProvider;
}

/** Built-in and explicitly bundled extensions share the same versioned boundary. */
export class ExtensionRegistry {
  private readonly entries = new Map<string, ExtensionContribution>();
  private sealed = false;

  register(extension: ExtensionContribution): () => void {
    if (this.sealed) throw new Error('Extensions must be registered before the registry is sealed.');
    const { manifest } = extension;
    if (manifest.apiVersion !== EXTENSION_API_VERSION) throw new Error(`Unsupported extension API: ${manifest.apiVersion}`);
    if (!/^[a-z][a-z0-9.-]{2,100}$/.test(manifest.id) || !manifest.name.trim() || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid extension manifest.');
    if (this.entries.has(manifest.id)) throw new Error(`Duplicate extension: ${manifest.id}`);
    if (manifest.capabilities.some(capability => !['markdown', 'references'].includes(capability))) throw new Error('Unsupported extension capability.');
    if (Boolean(extension.markdown) !== manifest.capabilities.includes('markdown') || Boolean(extension.references) !== manifest.capabilities.includes('references')) throw new Error('Extension capabilities do not match its contributions.');
    if (extension.references && [...this.entries.values()].some(entry => entry.references?.id === extension.references!.id)) throw new Error(`Duplicate reference provider: ${extension.references.id}`);
    const entry = Object.freeze({ ...extension, manifest: Object.freeze({ ...manifest, capabilities: Object.freeze([...manifest.capabilities]) }) });
    this.entries.set(manifest.id, entry);
    return () => { if (this.sealed) throw new Error('A sealed extension cannot be removed.'); if (this.entries.get(manifest.id) === entry) this.entries.delete(manifest.id); };
  }

  seal() { this.sealed = true; }
  list(): ExtensionManifest[] { return [...this.entries.values()].map(entry => ({ ...entry.manifest, capabilities: [...entry.manifest.capabilities] })); }
  installMarkdown(parser: ReturnType<typeof MarkdownIt>) { this.seal(); for (const extension of this.entries.values()) extension.markdown?.(parser); }
  referenceProvider(id: string): ReferenceProvider | undefined { return [...this.entries.values()].find(entry => entry.references?.id === id)?.references; }
}
