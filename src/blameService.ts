import * as vscode from 'vscode';
import { blame, getCommitInfo, getLogText, getLocalDiff, svnExecutablePath, svnVersion, BlameLine, CommitInfo, LocalDiff } from './svn';
import { findWorkingCopyRoot } from './util';

/**
 * blame 结果：内部保存 BASE 版本的 blame，
 * 通过本地 diff 把行号换算到当前文件，并标记未提交的本地修改行。
 */
export class BlameResult {
    constructor(
        private readonly baseLines: Map<number, BlameLine>,
        private readonly diff: LocalDiff | undefined
    ) { }

    /** 查询当前文件某一行（1 起）的提交信息 */
    getLine(lineNo: number): BlameLine | undefined {
        if (this.diff?.localLines.has(lineNo)) {
            return { line: lineNo, revision: 0, author: '', date: undefined, local: true };
        }
        const baseNo = this.diff ? (this.diff.toBase.get(lineNo) ?? lineNo + this.diff.offset) : lineNo;
        const info = this.baseLines.get(baseNo);
        if (!info) {
            return undefined;
        }
        return { ...info, line: lineNo };
    }
}

type CacheEntry =
    | { kind: 'ok'; result: BlameResult }
    | { kind: 'unsupported' }
    | { kind: 'error'; reason: string };

/**
 * blame / log 结果缓存：
 * - 同一文件同一时刻只执行一次 svn blame（pending 去重）
 * - 失败结果也会被缓存，避免每次悬停都重复调用 svn
 */
export class BlameService {
    private readonly blameCache = new Map<string, CacheEntry>();
    private readonly pending = new Map<string, Promise<CacheEntry>>();
    private readonly commitCache = new Map<string, CommitInfo | null>();
    private readonly rootCache = new Map<string, string | null>();

    private static rootKey(fsPath: string): string {
        return fsPath.replace(/[\\/][^\\/]*$/, '').toLowerCase();
    }

    /** 文件是否位于 SVN 工作副本内 */
    isTracked(fsPath: string): boolean {
        return this.workingCopyRoot(fsPath) !== undefined;
    }

    workingCopyRoot(fsPath: string): string | undefined {
        const key = BlameService.rootKey(fsPath);
        let root = this.rootCache.get(key);
        if (root === undefined) {
            root = findWorkingCopyRoot(fsPath) ?? null;
            this.rootCache.set(key, root);
        }
        return root ?? undefined;
    }

    /** 获取文件的 blame 结果；未纳入版本控制或失败时返回 undefined */
    async getBlame(uri: vscode.Uri, token?: vscode.CancellationToken): Promise<BlameResult | undefined> {
        const fsPath = uri.fsPath;
        const cached = this.blameCache.get(fsPath);
        if (cached) {
            return cached.kind === 'ok' ? cached.result : undefined;
        }

        let running = this.pending.get(fsPath);
        if (!running) {
            running = this.loadBlame(fsPath, token);
            this.pending.set(fsPath, running);
            running.finally(() => this.pending.delete(fsPath));
        }
        const entry = await running;
        return entry.kind === 'ok' ? entry.result : undefined;
    }

    private channel: vscode.OutputChannel | undefined;

    private log(message: string): void {
        if (!this.channel) {
            this.channel = vscode.window.createOutputChannel('SVN Blame');
        }
        this.channel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    }

    /** 输出诊断信息，用于排查「悬停没有内容」的问题 */
    async diagnose(fsPath: string): Promise<string> {
        const lines: string[] = [];
        lines.push(`文件：${fsPath}`);
        lines.push(`svn 可执行文件（svnBlame.svnPath）：${svnExecutablePath()}`);
        try {
            lines.push(`svn --version --quiet：${await svnVersion()}`);
        } catch (err) {
            lines.push(`svn --version --quiet：调用失败 - ${err instanceof Error ? err.message : String(err)}`);
        }

        this.rootCache.delete(BlameService.rootKey(fsPath));
        const root = this.workingCopyRoot(fsPath);
        lines.push(`工作副本根目录：${root ?? '（未找到 .svn —— 该文件不在 SVN 工作副本内，插件不会显示信息）'}`);
        if (!root) {
            return lines.join('\n');
        }

        this.invalidate(fsPath);
        const result = await this.getBlame(vscode.Uri.file(fsPath));
        const err = this.lastError(fsPath);
        lines.push(`svn blame：${result ? '成功' : `失败 - ${err ?? '未知原因'}`}`);
        if (result) {
            const first = result.getLine(1);
            lines.push(`第 1 行：${first ? (first.local ? '本地未提交' : `r${first.revision} ${first.author}`) : '无信息'}`);
        }
        return lines.join('\n');
    }

    private async loadBlame(fsPath: string, token?: vscode.CancellationToken): Promise<CacheEntry> {
        let entry: CacheEntry;
        if (!this.isTracked(fsPath)) {
            entry = { kind: 'unsupported' };
            this.log(`跳过（不在 SVN 工作副本内）：${fsPath}`);
        } else {
            try {
                const [baseLines, diff] = await Promise.all([
                    blame(fsPath, token),
                    getLocalDiff(fsPath).catch(() => undefined)
                ]);
                entry = { kind: 'ok', result: new BlameResult(baseLines, diff) };
                this.log(`blame 成功：${fsPath}（${baseLines.size} 行）`);
            } catch (err) {
                if (err instanceof Error && err.message === 'cancelled') {
                    throw err;
                }
                entry = { kind: 'error', reason: err instanceof Error ? err.message : String(err) };
                this.log(`blame 失败：${fsPath} - ${entry.reason}`);
            }
        }
        this.blameCache.set(fsPath, entry);
        return entry;
    }

    /** 获取某次提交的日志信息（带缓存） */
    async getCommit(fsPath: string, revision: number, token?: vscode.CancellationToken): Promise<CommitInfo | undefined> {
        if (revision <= 0) {
            return undefined;
        }
        const key = `${this.workingCopyRoot(fsPath) ?? fsPath}|${revision}`;
        const cached = this.commitCache.get(key);
        if (cached !== undefined) {
            return cached ?? undefined;
        }
        try {
            const info = await getCommitInfo(fsPath, revision, token);
            this.commitCache.set(key, info ?? null);
            return info;
        } catch {
            // log 失败不影响 blame 展示，缓存为 null 避免反复重试
            this.commitCache.set(key, null);
            return undefined;
        }
    }

    /** 获取某次提交的完整日志文本（svn log -v） */
    async getLog(fsPath: string, revision: number): Promise<string> {
        return getLogText(fsPath, revision);
    }

    /** 失效某个文件的缓存（保存、关闭、手动刷新时调用） */
    invalidate(fsPath: string): void {
        this.blameCache.delete(fsPath);
        this.pending.delete(fsPath);
    }

    clear(): void {
        this.blameCache.clear();
        this.pending.clear();
        this.commitCache.clear();
        this.rootCache.clear();
    }

    /** 最后一次 blame 的错误原因（用于提示） */
    lastError(fsPath: string): string | undefined {
        const entry = this.blameCache.get(fsPath);
        return entry && entry.kind === 'error' ? entry.reason : undefined;
    }
}

export const blameService = new BlameService();
