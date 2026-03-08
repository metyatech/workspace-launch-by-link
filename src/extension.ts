import * as vscode from 'vscode';
import fetch from 'cross-fetch';
import { isBinaryFile } from 'isbinaryfile';
import * as path from 'path';
import os from 'os';

// Types
type ManifestEntry = {
    path: string; // relative path
    type: 'file' | 'directory';
    contentBase64?: string; // present when type === 'file'
};

interface StartPayload {
    ownerId?: string;
    workspaceId?: string;
}

interface SyncConfig {
    serverUrl: string;
    payload?: StartPayload;
}

// Retry queue with infinite retries and cancellable UI error
class RetryQueue {
    private queue: Array<() => Promise<void>> = [];
    private running = false;
    private errorItem?: vscode.StatusBarItem;

    constructor(private ctx: vscode.ExtensionContext) {}

    enqueue(task: () => Promise<void>) {
        this.queue.push(task);
        this.run();
    }

    private async run() {
        if (this.running) {
            return;
        }
        this.running = true;
        try {
            while (this.queue.length) {
                const task = this.queue.shift()!;
                let delay = 1000; // start 1s, max 30s
                for (;;) {
                    try {
                        await task();
                        await this.clearError();
                        break;
                    } catch (err: unknown) {
                        const msg = err instanceof Error ? err.message : String(err);
                        await this.showError(`送信失敗。再試行します: ${msg}`);
                        await new Promise((r) => setTimeout(r, delay));
                        delay = Math.min(delay * 2, 30000);
                    }
                }
            }
        } finally {
            this.running = false;
        }
    }

    private async showError(message: string) {
        if (!this.errorItem) {
            this.errorItem = vscode.window.createStatusBarItem(
                vscode.StatusBarAlignment.Left,
                10000,
            );
            this.errorItem.text = '$(error) Workspace Launch by Link Error';
            this.errorItem.tooltip = message;
            this.errorItem.show();
        } else {
            this.errorItem.tooltip = message;
            this.errorItem.show();
        }
    }

    private async clearError() {
        if (this.errorItem) {
            this.errorItem.hide();
        }
    }
}

// utils
async function ensureDir(dir: vscode.Uri) {
    try {
        await vscode.workspace.fs.createDirectory(dir);
    } catch {
        // ignore
    }
}

async function writeFileFromBase64(target: vscode.Uri, base64: string) {
    const buf = Buffer.from(base64, 'base64');
    await vscode.workspace.fs.writeFile(target, buf);
}

async function cleanupOldSessions(baseRoot: vscode.Uri) {
    try {
        const openFolders = (vscode.workspace.workspaceFolders || []).map((wf) => wf.uri.fsPath);
        const preserve = new Set(
            openFolders.filter((p) => p.startsWith(baseRoot.fsPath + path.sep)).map((p) => p),
        );
        let entries: [string, vscode.FileType][] = [];
        try {
            entries = await vscode.workspace.fs.readDirectory(baseRoot);
        } catch (e) {
            console.error('Failed to read sessions root for cleanup:', baseRoot.fsPath, e);
            entries = [];
        }
        for (const [name] of entries) {
            const child = vscode.Uri.joinPath(baseRoot, name);
            if (preserve.has(child.fsPath)) {
                continue;
            }
            try {
                await vscode.workspace.fs.delete(child, { recursive: true, useTrash: false });
            } catch (e) {
                console.error('Failed to delete old session path:', child.fsPath, e);
            }
        }
    } catch (e) {
        console.error('Unexpected error during cleanupOldSessions:', baseRoot.fsPath, e);
    }
}

async function downloadAndMaterializeWorkspace(
    serverUrl: string,
    payload: StartPayload,
): Promise<vscode.Uri> {
    // GET serverUrl + '/manifest' with payload as query
    const url = new URL(serverUrl);
    url.pathname = '/manifest';
    if (payload.ownerId) {
        url.searchParams.set('ownerId', payload.ownerId);
    }
    if (payload.workspaceId) {
        url.searchParams.set('workspaceId', payload.workspaceId);
    }

    const res = await fetch(url.toString());
    if (!res.ok) {
        throw new Error(`manifest fetch failed: ${res.status}`);
    }
    const manifest: ManifestEntry[] = await res.json();

    // Create a temp workspace folder (cleanup old sessions first)
    const sessionsRoot = vscode.Uri.joinPath(
        vscode.Uri.file(os.tmpdir()),
        'workspace-launch-by-link',
    );
    await ensureDir(sessionsRoot);
    await cleanupOldSessions(sessionsRoot);
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const folderName = `session-${unique}-${payload.workspaceId ?? 'unknown'}`;
    const workspaceRoot = vscode.Uri.joinPath(sessionsRoot, folderName);
    await ensureDir(workspaceRoot);

    for (const entry of manifest) {
        const target = vscode.Uri.joinPath(workspaceRoot, entry.path);
        if (entry.type === 'directory') {
            await ensureDir(target);
        } else {
            await ensureDir(vscode.Uri.file(path.dirname(target.fsPath)));
            await writeFileFromBase64(target, entry.contentBase64 || '');
        }
    }

    // Write sync config marker
    const config: SyncConfig = { serverUrl, payload };
    // Save marker under .vscode for cleanliness
    const vscodeDir = vscode.Uri.joinPath(workspaceRoot, '.vscode');
    await ensureDir(vscodeDir);
    const markerUri = vscode.Uri.joinPath(vscodeDir, 'workspace-launch-by-link.json');
    await vscode.workspace.fs.writeFile(
        markerUri,
        Buffer.from(JSON.stringify(config, null, 2), 'utf8'),
    );

    // 1) VS Code Explorer: files.exclude に設定（失敗しても続行）
    try {
        const settingsUri = vscode.Uri.joinPath(vscodeDir, 'settings.json');
        let settings: Record<string, unknown> = {};
        try {
            const bytes = await vscode.workspace.fs.readFile(settingsUri);
            settings = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
        } catch {
            settings = {};
        }
        settings['files.exclude'] = {
            ...(settings['files.exclude'] || {}),
            '**/.vscode': true,
        };
        await vscode.workspace.fs.writeFile(
            settingsUri,
            Buffer.from(JSON.stringify(settings, null, 2), 'utf8'),
        );
    } catch (e) {
        console.error('Failed to update files.exclude for marker hiding:', e);
    }

    return workspaceRoot;
}

function parseInvokeUri(uri: vscode.Uri): SyncConfig {
    // vscode://publisher.extension/start?server=https://..&ownerId=..&workspaceId=..
    const params = new URLSearchParams(uri.query);
    const server = params.get('server');
    if (!server) {
        throw new Error('server パラメータが必要です');
    }
    const payload: StartPayload = {
        ownerId: params.get('ownerId') || undefined,
        workspaceId: params.get('workspaceId') || undefined,
    };
    return { serverUrl: server, payload };
}

export async function activate(context: vscode.ExtensionContext) {
    const queue = new RetryQueue(context);
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10001);
    status.text = '$(sync) Workspace Launch by Link: idle';
    status.show();
    context.subscriptions.push(status);

    async function startSync(config: SyncConfig) {
        status.text = '$(sync~spin) Workspace Launch by Link: starting';
        // if no workspace open or not the marker, materialize then open
        const root = await downloadAndMaterializeWorkspace(config.serverUrl, config.payload || {});
        // open folder in current window (reuse if possible)
        await vscode.commands.executeCommand('vscode.openFolder', root, {
            forceNewWindow: false,
            forceReuseWindow: true,
        });
    }

    // URI handler
    const uriHandler: vscode.UriHandler = {
        handleUri: async (uri: vscode.Uri) => {
            try {
                const cfg = parseInvokeUri(uri);
                await startSync(cfg);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Workspace Launch by Link 起動エラー: ${msg}`);
            }
        },
    };
    context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));

    // Command for manual status
    context.subscriptions.push(
        vscode.commands.registerCommand('workspaceLaunchByLink.showStatus', () => {
            vscode.window.showInformationMessage('Workspace Launch by Link は有効です。');
        }),
    );

    // Auto start when marker file exists in workspace
    const wsFolders = vscode.workspace.workspaceFolders;
    if (wsFolders) {
        for (const folder of wsFolders) {
            const marker = vscode.Uri.joinPath(
                folder.uri,
                '.vscode',
                'workspace-launch-by-link.json',
            );
            try {
                const data = await vscode.workspace.fs.readFile(marker);
                const cfg: SyncConfig = JSON.parse(Buffer.from(data).toString('utf8'));
                beginWatchAndSync(context, cfg, queue, folder.uri, status);
            } catch {
                // ignore
            }
        }
    }
}

async function beginWatchAndSync(
    context: vscode.ExtensionContext,
    cfg: SyncConfig,
    queue: RetryQueue,
    root: vscode.Uri,
    status: vscode.StatusBarItem,
) {
    status.text = '$(sync~spin) Workspace Launch by Link: running';

    const basePayload: StartPayload | undefined = cfg.payload
        ? {
              ownerId: cfg.payload.ownerId,
              workspaceId: cfg.payload.workspaceId,
          }
        : undefined;

    const postJson = async (path: string, body: object) => {
        await fetch(new URL(path, cfg.serverUrl).toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, ...basePayload }),
        }).then((r) => {
            if (!r.ok) {
                throw new Error(`HTTP ${r.status}`);
            }
        });
    };

    const sendFileSnapshot = async (abs: vscode.Uri) => {
        const rel = path.relative(root.fsPath, abs.fsPath).replace(/\\/g, '/');
        const bytes = await vscode.workspace.fs.readFile(abs);
        const buf = Buffer.from(bytes);
        const isBin = await isBinaryFile(buf);
        const content = isBin ? buf.toString('base64') : buf.toString('utf8');
        const payload = {
            path: rel,
            isBinary: isBin,
            content: isBin ? content : Buffer.from(content).toString('base64'),
        };
        queue.enqueue(() => postJson('/event/fileSnapshot', payload));
    };

    // Initial full snapshot of workspace
    const collectAllFiles = async (dir: vscode.Uri): Promise<vscode.Uri[]> => {
        const items = await vscode.workspace.fs.readDirectory(dir);
        const files: vscode.Uri[] = [];
        for (const [name, ftype] of items) {
            const child = vscode.Uri.joinPath(dir, name);
            if (ftype === vscode.FileType.Directory) {
                files.push(...(await collectAllFiles(child)));
            } else if (ftype === vscode.FileType.File) {
                files.push(child);
            }
        }
        return files;
    };

    try {
        const all = await collectAllFiles(root);
        for (const f of all) {
            await sendFileSnapshot(f);
        }
    } catch (e) {
        console.error(e);
    }

    // Watchers
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(root, '**/*'),
    );
    context.subscriptions.push(watcher);

    watcher.onDidCreate((uri) => {
        (async () => {
            const rel = path.relative(root.fsPath, uri.fsPath).replace(/\\/g, '/');
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.type & vscode.FileType.Directory) {
                    queue.enqueue(() =>
                        postJson('/event/create', { path: rel, isDirectory: true }),
                    );
                } else if (stat.type & vscode.FileType.File) {
                    queue.enqueue(() =>
                        postJson('/event/create', { path: rel, isDirectory: false }),
                    );
                    queue.enqueue(() => sendFileSnapshot(uri));
                }
            } catch {
                // if stat fails, best-effort assume file
                queue.enqueue(() => postJson('/event/create', { path: rel }));
                queue.enqueue(() => sendFileSnapshot(uri));
            }
        })();
    });

    watcher.onDidChange((uri) => {
        (async () => {
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.type & vscode.FileType.File) {
                    queue.enqueue(() => sendFileSnapshot(uri));
                }
            } catch {
                // ignore
            }
        })();
    });

    watcher.onDidDelete((uri) => {
        const rel = path.relative(root.fsPath, uri.fsPath).replace(/\\/g, '/');
        queue.enqueue(() => postJson('/event/delete', { path: rel }));
    });

    context.subscriptions.push(
        vscode.workspace.onDidRenameFiles((e) => {
            for (const f of e.files) {
                const oldRel = path.relative(root.fsPath, f.oldUri.fsPath).replace(/\\/g, '/');
                const newRel = path.relative(root.fsPath, f.newUri.fsPath).replace(/\\/g, '/');
                queue.enqueue(() =>
                    postJson('/event/rename', { oldPath: oldRel, newPath: newRel }),
                );
            }
        }),
    );

    // Text document change (debounced per doc)
    const pendingTimers = new Map<string, NodeJS.Timeout>();
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((e) => {
            const uri = e.document.uri;
            if (uri.scheme !== 'file' || !uri.fsPath.startsWith(root.fsPath)) {
                return;
            }
            const key = uri.toString();
            const existing = pendingTimers.get(key);
            if (existing) {
                clearTimeout(existing);
            }
            pendingTimers.set(
                key,
                setTimeout(async () => {
                    pendingTimers.delete(key);
                    try {
                        await sendFileSnapshot(uri);
                    } catch {
                        // snapshot is already enqueued with retry
                    }
                }, 500),
            );
        }),
    );

    // Heartbeat
    const hb = setInterval(() => {
        queue.enqueue(() => postJson('/event/heartbeat', { ts: Date.now() }));
    }, 30000);
    context.subscriptions.push({ dispose: () => clearInterval(hb) });
}

export function deactivate() {}
