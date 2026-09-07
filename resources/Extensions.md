# Markedown 扩展接口

本文描述当前已经使用的内建扩展边界。接口版本为 `1`，不是任意第三方插件的运行时加载器。本版没有插件目录扫描、从文稿加载脚本、在线插件市场或外部插件安装入口。新增扩展需要作为受审查的应用源码显式编译和打包。

## 注册表

`src/shared/extensions.ts` 提供 `ExtensionRegistry`、`ExtensionManifest` 和 `ExtensionContribution`。

```ts
interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: 1;
  capabilities: readonly ('markdown' | 'references')[];
}
```

扩展 ID 使用小写字母开头的字母、数字、点或连字符；版本是 `1.0.0` 形式的三个数字段。注册表拒绝不支持的接口版本、重复 ID、重复文献提供器 ID，以及能力声明与实际贡献不一致的条目。

`register()` 返回注销函数，但只能在注册表封闭前调用。`installMarkdown(parser)` 自动封闭注册表，并把已注册的 Markdown 安装函数应用到指定解析器；`seal()` 也可以显式封闭。封闭后不能注册或注销扩展。维护者应为每个解析器只安装一次，避免规则重复。

现有内建扩展：

| ID | 能力 | 用途 |
| --- | --- | --- |
| `markedown.equations` | `markdown` | 公式标签引用语法与渲染 |
| `markedown.citations` | `markdown` | 文献引用与参考文献占位符 |
| `markedown.zotero` | `references` | 主进程中的 Zotero 本地文献提供器 |

Markdown 注册表在共享渲染模块中创建；文献提供器注册表在主进程中创建。它们是明确的应用装配点，并非一个可由渲染进程任意修改的全局插件容器。

## ReferenceProvider

`src/shared/academic-contracts.ts` 定义完整类型。提供器返回书目数据，由主进程的 `CitationService` 负责格式化。

```ts
interface ReferenceProvider {
  id: string;
  name: string;
  status(): Promise<ReferenceStatus>;
  search(query: string, signal?: AbortSignal): Promise<ReferenceSearch>;
  resolve(keys: string[], refresh?: boolean): Promise<ReferenceResolution>;
}
```

`ReferenceItem` 包含 `key`、`csl`、`title`、`authors` 和 `year`。`ReferenceSearch` 返回 `items` 与 `hasMore`；`ReferenceResolution` 返回 `items`、`missing`、`offline` 和 `warnings`。搜索应遵守传入的 `AbortSignal`；条目缺失应进入 `missing`，而不应伪造书目信息。

以下示例可作为 `src/main/example-reference-provider.ts` 的起点。它是内存提供器，没有网络请求；示例键符合现有引文解析器的八位大写字母／数字约定。

```ts
import { ExtensionRegistry } from '../shared/extensions';
import type {
  ReferenceItem,
  ReferenceProvider,
} from '../shared/academic-contracts';

const example: ReferenceItem = {
  key: 'DEMO0001',
  title: 'Example Reference',
  authors: 'Example, A.',
  year: '2026',
  csl: {
    id: 'DEMO0001',
    type: 'article-journal',
    title: 'Example Reference',
    author: [{ family: 'Example', given: 'A.' }],
    issued: { 'date-parts': [[2026]] },
  },
};

const items = new Map([[example.key, example]]);

export const provider: ReferenceProvider = {
  id: 'example-memory',
  name: 'Example References',
  async status() {
    return { available: true, version: '1.0.0' };
  },
  async search(query, signal) {
    signal?.throwIfAborted();
    const needle = query.trim().toLowerCase();
    return {
      items: [...items.values()]
        .filter(item => item.title.toLowerCase().includes(needle))
        .map(item => structuredClone(item)),
      hasMore: false,
    };
  },
  async resolve(keys, _refresh = false) {
    const unique = [...new Set(keys)];
    if (unique.length > 500 || unique.some(key => !/^[A-Z0-9]{8}$/.test(key))) {
      throw new Error('Unsupported reference keys.');
    }
    return {
      items: unique.flatMap(key => {
        const item = items.get(key);
        return item ? [structuredClone(item)] : [];
      }),
      missing: unique.filter(key => !items.has(key)),
      offline: false,
      warnings: [],
    };
  },
};

const registry = new ExtensionRegistry();
registry.register({
  manifest: {
    id: 'example.references',
    name: 'Example References',
    version: '1.0.0',
    apiVersion: 1,
    capabilities: ['references'],
  },
  references: provider,
});
registry.seal();
const selected = registry.referenceProvider('example-memory');
```

示例不会自动增加 UI 的提供器选择项。实际接入还需要维护者在主进程装配 `CitationService`，明确选择提供器，并补充缓存、错误、超时、取消和元数据验证。现有用户界面选择的是 Zotero；其他提供器必须遵守当前条目键语法，或连同解析器契约一起升级。

## Markdown 贡献

Markdown 贡献是 `(parser: ReturnType<typeof MarkdownIt>) => void`，在解析之前安装规则，不在渲染过程中临时添加规则。引用等需要整篇文稿上下文的能力应把结构化结果放入渲染环境，而不是使用跨文稿的可变单例状态。

共享渲染入口 `renderMarkdown(source, options)` 接受：

| 选项 | 意义 |
| --- | --- |
| `settings` | 当前设置快照 |
| `purpose` | `editor`、`export`、`copy` 或 `htmlPlain` |
| `equationIndex` | 整篇公式与引用索引 |
| `sourceOffset` | 当前片段在整篇源码中的 UTF-16 偏移 |
| `citations` | 主进程已经解析和清理的 `CitationRenderData` |
| `imageURL` | 受控的本地图片地址解析函数 |

`getEquationIndex(source, settings)` 返回 `equations`、`references` 和 `diagnostics`。公式条目携带源码范围、标签、字符串编号、稳定锚点与重复标记；局部编辑器渲染应传入整篇索引和真实 `sourceOffset`，不能为每个小组件单独从 1 编号。

`CitationRenderData.clusters` 以完整原始引文串为键，例如 `[@D9PGQUM4; @T4IQZGRM]`；值是 citeproc-js 排版后经主进程清理的 HTML。其余字段为 `bibliography`、`entries`、`missing`、`warnings` 和 `offline`。普通渲染扩展不应把未知 HTML 直接装进这些字段。

参考文献占位符常量 `BIBLIOGRAPHY_MARKER` 是 `<!-- markedown:bibliography -->`。它由明确的 Markdown 规则识别，不意味着开放任意 HTML。新增规则也不应启用任意文稿 HTML、脚本或远程资源。

## 进程与数据边界

渲染进程通过 `window.markedown.references` 调用 `status()`、`search(query)`、`cancelSearch()` 和 `resolve(source, refresh)`。文件、缓存、HTTP 与 citeproc 格式化留在主进程；界面不直接访问 Node、Zotero 数据库或用户文件系统。

现有 Zotero 提供器只接受本机回环 `/api/` 地址，默认个人库为 `users/0`，每次 HTTP 请求最长六秒、响应最大 8 MiB，单条 CSL 元数据最大 128 KiB。其字段白名单保留书目用途的数据，过滤附件、笔记和注释，并只保留无凭据的 HTTP(S) 文献 URL。缓存位于应用数据目录的 `references/zotero`，使用按条目验证的 JSON 记录。

文稿中仅持久化 Markdown、公式标签、八位引文键与参考文献占位符。API 密钥、Zotero 全文、CSL 缓存和格式化 HTML 不自动写入 Markdown。新增提供器应维持这一约定。

注册表仅校验结构和版本，不是第三方代码沙箱。随包扩展属于受信任的应用代码，需要同样的源码审查、依赖许可证和测试；本版不提供外部插件权限授予机制。
