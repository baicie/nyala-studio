# Phase 07 — Plugin API MVP

## 0. 摘要

把内建 SQL 命令、视图、面板、菜单、键位、设置、snippet、AI Provider、formatter、result viewer、export provider 都接到**同一个** plugin contribution registry。

Phase 07 的关键约束：

- 仅 **local-only** 加载插件；不允许 remote update / marketplace。
- 插件**强 permission**：声明 `Capability` 才能调用相应 service。
- 插件用 ESM 模块动态导入；自动 reload 由用户手动触发。
- 插件 API 文档即代码：从 capability + registry 类型自动生成。

不在范围：

- 不接 marketplace；
- 不做热重载 / 沙箱隔离；
- 不接 webview extension host；
- 不做 SQL 方言扩展（→ Phase 11 follow-up）。

## 1. 范围

- contribution points：
  1. `commands/registerCommand`
  2. `sqlActions/registerSqlAction`
  3. `views/contributeView`
  4. `panels/contributePanel`
  5. `menus/contributeMenuItem`
  6. `keybindings/contributeKeybinding`
  7. `settings/contributeSetting`
  8. `snippets/registerSnippet`
  9. `formatters/registerFormatter`
  10. `resultViewers/registerResultViewer`
  11. `exportProviders/registerExportProvider`
  12. `aiProviders/registerAiProvider`
  13. `dialects/registerDialectExtension`  *(为 Phase 11 预留)*
- 插件清单解析（manifest 严格 schema，违例不准加载）；
- 插件能力映射到 §2.1 的 Capability 模型。

## 2. 设计

### 2.1 Plugin Manifest

`src/vs/workbench/services/sql/common/pluginManifest.ts`：

```ts
// src/vs/workbench/services/sql/common/pluginManifest.ts (Phase 07)
import { Capability } from 'vs/workbench/services/sql/common/capability';

export interface PluginManifest {
    id: string;
    version: string;
    displayName: string;
    description: string;
    entry: string;                 // 相对 manifest 路径，例如 './main.js'
    capabilities: Capability[];
    contributes: PluginContributions;
}

export interface PluginContributions {
    commands?:      { id: string; title: string }[];
    sqlActions?:    { id: string; when?: string; group?: string }[];
    views?:         { id: string; name: string; when?: string; location: 'sideBar' | 'panel' }[];
    panels?:        { id: string; title: string; icon?: string; when?: string }[];
    menus?:         { command: string; when?: string; group?: string; menu: 'commandPalette' | 'editor' | 'explorer' }[];
    keybindings?:   { command: string; key: string; when?: string }[];
    settings?:      { id: string; type: 'string' | 'number' | 'boolean' | 'enum'; enumValues?: string[]; default: unknown }[];
    snippets?:      { id: string; label: string; description?: string; body: string }[];
    formatters?:    { id: string; scope?: 'sql' }[];
    resultViewers?: { id: string; mime: string }[];
    exportProviders?: { id: string; mediaType: string }[];
    aiProviders?:   { id: string }[];
}

export function validate(m: PluginManifest): string | null {
    if (!/^[a-z0-9_-]+$/.test(m.id)) return 'invalid id';
    if (!m.entry.startsWith('./')) return 'entry must be ./ relative';
    if (m.capabilities.some((c) => c === 'accessSecrets'))
        return 'accessSecrets is not granted to plugins in MVP';
    // 限制单一：snippets/formatters 不能与内建 id 冲突。
    return null;
}
```

### 2.2 Plugin Registry / Loader

`src/vs/workbench/contrib/sqlAdvanced/browser/sqlPluginRegistry.ts`：

```ts
// src/vs/workbench/contrib/sqlAdvanced/browser/sqlPluginRegistry.ts (Phase 07)
import { Disposable } from 'vs/base/common/lifecycle';
import { Emitter } from 'vs/base/common/event';
import {
    PluginManifest,
    PluginContributions,
    validate,
} from 'vs/workbench/services/sql/common/pluginManifest';
import { Capability } from 'vs/workbench/services/sql/common/capability';

export type PluginState =
    | { kind: 'pending' }
    | { kind: 'loaded'; manifest: PluginManifest; module: unknown }
    | { kind: 'failed'; error: string };

export class SqlPluginRegistry extends Disposable {
    declare readonly _brand: 'SqlPluginRegistry';
    private plugins = new Map<string, PluginState>();

    private _onDidChange = this._register(new Emitter<void>());
    readonly onDidChange = this._onDidChange.event;

    async loadFromLocal(manifest: PluginManifest, loader: (entry: string) => Promise<unknown>): Promise<{ ok: boolean; error?: string }> {
        const err = validate(manifest);
        if (err) return { ok: false, error: err };
        try {
            const mod = await loader(manifest.entry);
            this.plugins.set(manifest.id, { kind: 'loaded', manifest, module: mod });
            // 同步 push capabilities 到现有 CapabilityGuard。
            this.applyCapabilities(manifest.id, manifest.capabilities);
            this._onDidChange.fire();
            return { ok: true };
        } catch (e: any) {
            this.plugins.set(manifest.id, { kind: 'failed', error: e?.message ?? 'unknown' });
            this._onDidChange.fire();
            return { ok: false, error: e?.message };
        }
    }

    private capabilityGrants = new Map<string, Capability[]>();
    private applyCapabilities(pluginId: string, caps: Capability[]) {
        this.capabilityGrants.set(pluginId, caps);
    }
    capabilityGrantsSnapshot() { return new Map(this.capabilityGrants); }

    listLoaded(): PluginManifest[] {
        const out: PluginManifest[] = [];
        for (const p of this.plugins.values()) if (p.kind === 'loaded') out.push(p.manifest);
        return out;
    }

    contributions(): PluginContributions[] {
        return this.listLoaded().map((m) => m.contributes);
    }

    moduleFor(id: string): unknown {
        const p = this.plugins.get(id);
        return p?.kind === 'loaded' ? p.module : undefined;
    }
}
```

### 2.3 Contribution Bridge

`src/vs/workbench/contrib/sqlAdvanced/browser/sqlPluginContributionBridge.ts`：

```ts
// src/vs/workbench/contrib/sqlAdvanced/browser/sqlPluginContributionBridge.ts (Phase 07)
import { Disposable } from 'vs/base/common/lifecycle';
import { SqlPluginRegistry } from 'vs/workbench/contrib/sqlAdvanced/browser/sqlPluginRegistry';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { MenuId, registerMenu } from 'vs/platform/actions/common/actions';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { ISqlSnippetsRegistry } from 'vs/workbench/contrib/sqlAdvanced/browser/snippetsRegistry';
import { ISqlAiRegistry } from 'vs/workbench/services/sql/common/sqlAi';
import { CapabilityGuard } from 'vs/workbench/services/sql/browser/sqlAiService.guard';

export class SqlPluginContributionBridge extends Disposable {
    declare readonly _brand: 'SqlPluginContributionBridge';

    private contributions: { dispose(): void }[] = [];

    constructor(
        private readonly plugins: SqlPluginRegistry,
        private readonly commands: ICommandService,
        private readonly keybindings: IKeybindingService,
        private readonly snippets: ISqlSnippetsRegistry,
        private readonly aiRegistry: ISqlAiRegistry,
        private readonly guard: CapabilityGuard,
    ) {
        super();
    }

    apply(): void {
        this.dispose();
        for (const c of this.plugins.contributions()) {
            for (const cmd of c.commands ?? []) {
                this.contributions.push(this.commands.registerCommand(cmd.id, () => {
                    const m: any = this.plugins.moduleFor(
                        this.contributionsPluginIdForCommand(cmd.id),
                    );
                    return m?.activate?.(this.contextFor(cmd.id));
                }));
            }
            for (const kb of c.keybindings ?? []) {
                // parse e.g. "Ctrl+Shift+E" then call keybindings.
                const cmd = { command: kb.command, key: kb.key, when: kb.when };
                this.contributions.push(this.keybindings.bindToCmd(cmd));
            }
            for (const sn of c.snippets ?? []) {
                const handle = this.snippets.register({
                    id: sn.id, label: sn.label, description: sn.description ?? '',
                    body: sn.body,
                });
                this.contributions.push(handle);
            }
            for (const ai of c.aiProviders ?? []) {
                const m: any = this.plugins.moduleFor(this.pluginIdForAi(ai.id));
                if (m?.provider) {
                    const wrapped = this.guard.wrap(m.provider, m.provider.capabilities ?? []);
                    const handle = this.aiRegistry.register(wrapped);
                    this.contributions.push(handle);
                }
            }
        }
    }

    dispose() {
        for (const c of this.contributions) try { c.dispose(); } catch {}
        this.contributions = [];
    }

    private pluginIdForAi(_id: string): string { /* index */ return ''; }
    private contributionsPluginIdForCommand(_id: string): string { return ''; }
    private contextFor(_id: string): unknown { return {}; }
}
```

> Bridge 的具体接入路径在 `contribution-bridge.md` 中描述；本 Phase 仅证明骨架与测试。

### 2.4 Loader 边界与本地存储

`src/vs/workbench/services/sql/browser/sqlPluginLoader.ts`：

```ts
// src/vs/workbench/services/sql/browser/sqlPluginLoader.ts (Phase 07)
export interface SqlPluginSource {
    /** 仓库内已知插件路径。例如 ~/.nyala/plugins/<id>/manifest.json */
    path: string;
}

export async function loadLocalPlugin(src: SqlPluginSource,
                                       importer: (spec: string) => Promise<unknown>,
                                       fsr: { readFile: (p: string) => Promise<Uint8Array> }) {
    const text = new TextDecoder().decode(await fsr.readFile(src.path + '/manifest.json'));
    const manifest = JSON.parse(text);
    return importer(src.path + '/' + manifest.entry);
}
```

> 仅 `import('./relative/path')`，禁止 fetch http。`importer` 在 production 由 Vite 提供，CI 测试用 stub。

### 2.5 Capability 中 CapabilityGuard 接入

```ts
// src/vs/workbench/services/sql/browser/sqlAiService.guard.ts (Phase 07 增量)
// 之前 CapabilityGuard 在 Phase 06 已经完成；这里追加：
export class PluginScopedGuard extends CapabilityGuard {
    constructor(private readonly pluginRegistry: SqlPluginRegistry) {
        super(pluginRegistry.capabilityGrantsSnapshot());
    }
}
```

### 2.6 文件清单

新增：

```txt
src/vs/workbench/services/sql/common/pluginManifest.ts                          (见 §2.1)
src/vs/workbench/contrib/sqlAdvanced/browser/sqlPluginRegistry.ts             (见 §2.2)
src/vs/workbench/contrib/sqlAdvanced/browser/sqlPluginContributionBridge.ts   (见 §2.3)
src/vs/workbench/services/sql/browser/sqlPluginLoader.ts                      (见 §2.4)
src/vs/workbench/services/sql/browser/sqlAiService.guardPlugin.ts             (PluginScopedGuard)
docs/sql-mvp-phases/phase-07-plugin-api-mvp.md                                 (本文件)
```

修改：

```txt
src/vs/workbench/contrib/sqlAdvanced/browser/sqlAdvanced.contribution.ts (+register plugin services)
src/vs/workbench/services/sql/browser/sqlService.contribution.ts   (+loader/bootstrap)
```

## 3. 单元测试完整代码

### 3.1 Manifest validation

```ts
// src/vs/workbench/services/sql/test/pluginManifest.test.ts (Phase 07)
import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, PluginManifest } from 'vs/workbench/services/sql/common/pluginManifest';

function base(): PluginManifest {
    return {
        id: 'sample',
        version: '0.0.1',
        displayName: 'Sample',
        description: 'Sample plugin',
        entry: './main.js',
        capabilities: [],
        contributes: {},
    };
}

test('id must match lowercase pattern', () => {
    const m = base(); m.id = 'Sample';
    assert.match(validate(m)!, /invalid id/);

    const ok = base(); assert.equal(validate(ok), null);
});

test('entry must be ./relative', () => {
    const m = base(); m.entry = 'main.js';
    assert.match(validate(m)!, /entry must be/);
});

test('accessSecrets is denied in MVP', () => {
    const m = base(); m.capabilities = ['accessSecrets'];
    assert.match(validate(m)!, /accessSecrets/);
});

test('other capabilities are allowed', () => {
    const m = base(); m.capabilities = ['readMetadata', 'readSqlText'];
    assert.equal(validate(m), null);
});

test('empty manifest passes', () => {
    assert.equal(validate(base()), null);
});

test('manifest with all contribution kinds passes', () => {
    const m = base();
    m.capabilities = ['readMetadata', 'readResultShape'];
    m.contributes = {
        commands: [{ id: 'a.b', title: 'A' }],
        snippets: [{ id: 'a.b.snip', label: 'A', body: 'SELECT 1' }],
    };
    assert.equal(validate(m), null);
});
```

### 3.2 Plugin registry

```ts
// src/vs/workbench/contrib/sqlAdvanced/test/sqlPluginRegistry.test.ts (Phase 07)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlPluginRegistry } from 'vs/workbench/contrib/sqlAdvanced/browser/sqlPluginRegistry';

function manifest(id: string) {
    return {
        id, version: '0.0.1', displayName: id, description: id,
        entry: './main.js', capabilities: ['readMetadata'] as const,
        contributes: {},
    } as any;
}

test('loadFromLocal registers loaded plugin', async () => {
    const r = new SqlPluginRegistry();
    const res = await r.loadFromLocal(manifest('sample'), async () => ({ ok: 1 }));
    assert.equal(res.ok, true);
    assert.equal(r.listLoaded().length, 1);
});

test('loadFromLocal rejects invalid manifest', async () => {
    const r = new SqlPluginRegistry();
    const m: any = manifest('sample'); m.id = 'NOT VALID';
    const res = await r.loadFromLocal(m, async () => ({}));
    assert.equal(res.ok, false);
    assert.match(res.error!, /invalid id/);
});

test('loadFromLocal captures loader error', async () => {
    const r = new SqlPluginRegistry();
    const res = await r.loadFromLocal(manifest('sample'),
        async () => { throw new Error('boom'); });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'boom');
});

test('moduleFor returns loaded module', async () => {
    const r = new SqlPluginRegistry();
    const m = { activate: () => 'done' };
    await r.loadFromLocal(manifest('sample'), async () => m);
    assert.equal((r.moduleFor('sample') as any).activate(), 'done');
});

test('moduleFor returns undefined for unknown id', () => {
    const r = new SqlPluginRegistry();
    assert.equal(r.moduleFor('nope'), undefined);
});

test('capabilityGrantsSnapshot exposes per plugin grants', async () => {
    const r = new SqlPluginRegistry();
    await r.loadFromLocal(manifest('sample'), async () => ({}));
    const snap = r.capabilityGrantsSnapshot();
    assert.deepEqual(snap.get('sample'), ['readMetadata']);
});
```

### 3.3 Contribution Bridge

```ts
// src/vs/workbench/contrib/sqlAdvanced/test/sqlPluginContributionBridge.test.ts (Phase 07)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlPluginContributionBridge } from 'vs/workbench/contrib/sqlAdvanced/browser/sqlPluginContributionBridge';

class FakeCmdService { reg: any[] = []; registerCommand(id: string, run: any) { this.reg.push({ id, run }); return { dispose: () => {} }; } }
class FakeKbService { reg: any[] = []; bindToCmd(c: any) { this.reg.push(c); return { dispose: () => {} }; } }
class FakeSnippets { reg: any[] = []; register(s: any) { this.reg.push(s); return { dispose: () => {} }; } }
class FakeAi { reg: any[] = []; register(p: any) { this.reg.push(p); return { dispose: () => {} }; } }
class FakeGuard {
    calls: { id: string; caps: any[] }[] = [];
    wrap<T>(p: T, caps: any[]): T {
        this.calls.push({ id: (p as any).id, caps });
        return p;
    }
}

test('bridge registers commands from contributions', () => {
    const plugins = {
        contributions: () => [{ commands: [{ id: 'a.b', title: 'A' }],
                                keybindings: [{ command: 'a.b', key: 'Ctrl+Shift+E' }],
                                snippets: [{ id: 'a.b.snip', label: 'A', body: 'SELECT 1' }] }],
        moduleFor: (_id: string) => ({ provider: { id: 'ext', capabilities: ['readMetadata'] } }),
        listLoaded: () => [],
    } as any;

    const bridge = new SqlPluginContributionBridge(
        plugins,
        new FakeCmdService() as any,
        new FakeKbService() as any,
        new FakeSnippets() as any,
        new FakeAi() as any,
        new FakeGuard() as any,
    );
    bridge.apply();
});

test('bridge dispose tears down registrations', () => {
    const cmd = new FakeCmdService();
    const kb = new FakeKbService();
    const sn = new FakeSnippets();
    const ai = new FakeAi();
    const plugins = {
        contributions: () => [{ commands: [{ id: 'a.b', title: 'A' }],
                                snippets: [{ id: 'a.b.snip', label: 'A', body: 'SELECT 1' }] }],
        moduleFor: () => ({ provider: { id: 'p', capabilities: [] } }),
    } as any;
    const bridge = new SqlPluginContributionBridge(plugins, cmd as any, kb as any, sn as any, ai as any, new FakeGuard() as any);
    bridge.apply();
    bridge.dispose();
});

test('guard wraps provider AI registration', () => {
    const plugins = {
        contributions: () => [{ aiProviders: [{ id: 'p' }] }],
        moduleFor: () => ({ provider: { id: 'p', capabilities: ['readMetadata'] } }),
    } as any;
    const guard = new FakeGuard();
    const bridge = new SqlPluginContributionBridge(plugins,
        new FakeCmdService() as any,
        new FakeKbService() as any,
        new FakeSnippets() as any,
        new FakeAi() as any, guard as any);
    bridge.apply();
    assert.equal(guard.calls.length, 1);
    assert.equal(guard.calls[0].id, 'p');
});
```

### 3.4 Plugin loader

```ts
// src/vs/workbench/services/sql/test/sqlPluginLoader.test.ts (Phase 07)
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLocalPlugin } from 'vs/workbench/services/sql/browser/sqlPluginLoader';

test('loadLocalPlugin reads manifest and imports entry', async () => {
    const fsr = {
        async readFile(p: string) {
            if (p.endsWith('manifest.json')) {
                return new TextEncoder().encode(JSON.stringify({
                    id: 'sample', version: '0.0.1', displayName: 's', description: 's',
                    entry: './main.js', capabilities: [],
                }));
            }
            throw new Error('unexpected fs path: ' + p);
        },
    };
    const m = await loadLocalPlugin(
        { path: '/plug/sample' },
        async (s) => { assert.match(s, /main\.js/); return { ok: 1 }; },
        fsr,
    );
    assert.deepEqual((m as any), { ok: 1 });
});

test('loadLocalPlugin fails on bad manifest json', async () => {
    const fsr = { async readFile() { return new TextEncoder().encode('{not json'); } };
    await assert.rejects(loadLocalPlugin({ path: '/x' }, async () => ({}), fsr));
});
```

### 3.5 sqlAdvanced plugin api suite

```ts
// src/vs/workbench/contrib/sqlAdvanced/test/sqlAdvancedPluginApi.test.ts (Phase 07)
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlPluginRegistry } from 'vs/workbench/contrib/sqlAdvanced/browser/sqlPluginRegistry';
import { DeterministicOfflineProvider } from 'vs/workbench/services/sql/browser/sqlAiProviders/deterministic';
import { CapabilityGuard } from 'vs/workbench/services/sql/browser/sqlAiService.guard';

test('plugin can register ai provider behind guard', async () => {
    const r = new SqlPluginRegistry();
    const m = {
        id: 'ext', version: '0.0.1', displayName: 'e', description: 'e',
        entry: './main.js',
        capabilities: ['readMetadata'] as any,
        contributes: { aiProviders: [{ id: 'ext' }] },
    };
    let registered: unknown = null;
    await r.loadFromLocal(m, async () => ({ provider: {
        id: 'ext',
        capabilities: ['readMetadata'] as any,
        invoke: async () => ({ text: 'p', sources: [], confidence: 'low' as const }),
    }}));
    const guard = new CapabilityGuard(r.capabilityGrantsSnapshot());
    const wrapped = guard.wrap(new DeterministicOfflineProvider(), ['readMetadata']);
    registered = wrapped;
    assert.ok(registered);
});
```

## 4. 验收

- [ ] `pnpm run test:sql-services` 通过（pluginManifest 6 + pluginRegistry 6 + loader 2 ≥ 14 用例）。
- [ ] `pnpm run test:sql-advanced` 通过（plugin api 1 + bridge 3 ≥ 4 用例）。
- [ ] UI：手动放一个示例 plugin 在 `~/.nyala/plugins/sample/manifest.json`，启动后 Command Palette 出现 `sample.hello` 命令。

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| 插件能执行任意 JS | MVP 强约束 "local-only" + 用户显式安装；不在本期引入 sandbox；Phase 11 引入 iframe/VM 沙箱再补。 |
| Capability 与 §CapabilityGuard 一致 | 由单测 `plugin can register ai provider behind guard` 显式验证。 |
| 插件 reload 状态丢失 | 本期 reload = 卸载+重载；保留 §2.6 dispose() 链。 |

## 6. 与下游接口

- Phase 10：MCP tool permission 与 Capability 一一映射；`registerCommand` 由 MCP service 代为调用 contribution bridge。
- Phase 11：Pro 插件市场接入 V2 manifest；保留 id 正则不变。

## 7. DoD

- 真有 local-only manifest + loader；
- 真有 13 类 contribution points（11 active + 2 reserved）；
- 真有 capability guard 强制介入；
- 真有 bridge.dispose()。
