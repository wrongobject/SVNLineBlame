import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { decodeXml, parseSvnDate } from './util';

export interface BlameLine {
    /** 行号，从 1 开始 */
    line: number;
    /** 修订号，0 表示本地未提交的修改 */
    revision: number;
    author: string;
    date?: Date;
    /** 是否为尚未提交的本地修改 */
    local: boolean;
}

export interface CommitInfo {
    revision: number;
    author: string;
    date?: Date;
    message: string;
}

function svnExecutable(): string {
    return vscode.workspace.getConfiguration('svnBlame').get<string>('svnPath', 'svn');
}

function timeoutMs(): number {
    const sec = vscode.workspace.getConfiguration('svnBlame').get<number>('timeout', 30);
    return Math.max(1, sec) * 1000;
}

/** 执行 svn 命令并返回 stdout */
export function runSvn(
    args: string[],
    cwd: string,
    token?: vscode.CancellationToken
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(svnExecutable(), args, {
                cwd,
                windowsHide: true,
                env: { ...process.env, LC_ALL: 'C' }
            });
        } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
        }

        let stdout = '';
        let stderr = '';
        let settled = false;
        let tokenSub: vscode.Disposable | undefined;
        const outStream = child.stdout;
        const errStream = child.stderr;
        outStream?.setEncoding('utf8');
        errStream?.setEncoding('utf8');
        outStream?.on('data', (chunk: string) => { stdout += chunk; });
        errStream?.on('data', (chunk: string) => { stderr += chunk; });

        const finish = (err?: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            tokenSub?.dispose();
            if (err) {
                reject(err);
            } else {
                resolve(stdout);
            }
        };

        const timer = setTimeout(() => {
            child.kill();
            finish(new Error(`svn 命令执行超时（${args[0]}）`));
        }, timeoutMs());

        tokenSub = token?.onCancellationRequested(() => {
            child.kill();
            finish(new Error('cancelled'));
        });

        child.on('error', (err: Error) => finish(err));
        child.on('close', (code: number) => {
            if (code === 0) {
                finish();
            } else {
                finish(new Error(stderr.trim() || `svn ${args[0]} 退出码 ${code}`));
            }
        });
    });
}

/** 当前生效的 svn 可执行文件路径（用于诊断） */
export function svnExecutablePath(): string {
    return svnExecutable();
}

/** 获取 svn 版本号（用于诊断） */
export async function svnVersion(): Promise<string> {
    const out = await runSvn(['--version', '--quiet'], process.cwd());
    return out.trim();
}

const ENTRY_RE = /<entry\b[^>]*line-number="(\d+)"[^>]*>([\s\S]*?)<\/entry>/g;
const COMMIT_RE = /<commit\s+revision="(-?\d+)"\s*>([\s\S]*?)<\/commit>/;
const AUTHOR_RE = /<author>([\s\S]*?)<\/author>/;
const DATE_RE = /<date>([\s\S]*?)<\/date>/;
const LOGENTRY_RE = /<logentry\b[^>]*revision="(\d+)"[^>]*>([\s\S]*?)<\/logentry>/;
const HUNK_RE = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/m;
const MSG_RE = /<msg>([\s\S]*?)<\/msg>/;

function pick(block: string, re: RegExp): string | undefined {
    const m = re.exec(block);
    return m ? decodeXml(m[1]) : undefined;
}

/** 本地修改信息：当前文件行号与 BASE 行号之间的映射 */
export interface LocalDiff {
    /** 当前文件行号 -> BASE 行号 */
    toBase: Map<number, number>;
    /** BASE 行号 -> 当前文件行号 */
    toNew: Map<number, number>;
    /** 本地新增或被修改的行号（当前文件行号） */
    localLines: Set<number>;
    /** 未落在任何 hunk 内的行使用的默认偏移：base = new + offset */
    offset: number;
}

/**
 * 对文件执行 svn blame（基于 BASE 版本），返回 BASE 行号 -> 提交信息 的映射。
 * 说明：直接对 WORKING 版本 blame 时，只要文件存在本地修改，svn 会把所有行都当作未提交，
 * 因此这里统一取 BASE，再由 LocalDiff 把行号换算到当前文件。
 * 文件未纳入版本控制或执行失败时抛出 Error。
 */
export async function blame(
    filePath: string,
    token?: vscode.CancellationToken
): Promise<Map<number, BlameLine>> {
    const out = await runSvn(
        ['blame', '--xml', '--non-interactive', '-r', 'BASE', path.basename(filePath)],
        path.dirname(filePath),
        token
    );

    const lines = new Map<number, BlameLine>();
    ENTRY_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ENTRY_RE.exec(out)) !== null) {
        const lineNo = Number(match[1]);
        const body = match[2];
        const commit = COMMIT_RE.exec(body);
        if (!commit) {
            // 本地未提交的修改
            lines.set(lineNo, { line: lineNo, revision: 0, author: '', date: undefined, local: true });
            continue;
        }
        const dateText = pick(commit[2], DATE_RE);
        lines.set(lineNo, {
            line: lineNo,
            revision: Number(commit[1]),
            author: pick(commit[2], AUTHOR_RE) ?? '',
            date: dateText ? parseSvnDate(dateText) : undefined,
            local: false
        });
    }
    return lines;
}

/** 解析 unified diff 文本，得到当前文件行号与 BASE 行号之间的映射 */
export function parseUnifiedDiff(text: string): LocalDiff {
    const toBase = new Map<number, number>();
    const toNew = new Map<number, number>();
    const localLines = new Set<number>();
    const rows = text.split(/\r?\n/);
    if (rows.length > 0 && rows[rows.length - 1] === '') {
        rows.pop();
    }

    let baseLine = 1;
    let newLine = 1;
    let offset = 0;
    let inHunk = false;

    for (const raw of rows) {
        const hunk = HUNK_RE.exec(raw);
        if (hunk) {
            const baseStart = Number(hunk[1]);
            const newStart = Number(hunk[2]);
            // 补齐两个 hunk 之间没有变更的行
            while (newLine < newStart) {
                toBase.set(newLine, newLine + offset);
                toNew.set(newLine + offset, newLine);
                newLine++;
            }
            baseLine = baseStart;
            inHunk = true;
            continue;
        }
        if (!inHunk) {
            continue;
        }
        if (raw.startsWith('+')) {
            localLines.add(newLine);
            newLine++;
        } else if (raw.startsWith('-')) {
            baseLine++;
        } else if (raw.startsWith('\\')) {
            // "\ No newline at end of file"，忽略
        } else {
            toBase.set(newLine, baseLine);
            toNew.set(baseLine, newLine);
            baseLine++;
            newLine++;
        }
        offset = baseLine - newLine;
    }

    return { toBase, toNew, localLines, offset };
}

/** 获取文件相对 BASE 的本地修改；无本地修改或失败时返回 undefined */
export async function getLocalDiff(
    filePath: string,
    token?: vscode.CancellationToken
): Promise<LocalDiff | undefined> {
    const out = await runSvn(
        ['diff', '--non-interactive', '--ignore-properties', path.basename(filePath)],
        path.dirname(filePath),
        token
    );
    if (!out.trim() || !HUNK_RE.test(out)) {
        return undefined;
    }
    return parseUnifiedDiff(out);
}

/** 获取某个修订号的提交信息（svn log） */
export async function getCommitInfo(
    filePath: string,
    revision: number,
    token?: vscode.CancellationToken
): Promise<CommitInfo | undefined> {
    const out = await runSvn(
        ['log', '--xml', '--non-interactive', '-r', String(revision), '--limit', '1', path.basename(filePath)],
        path.dirname(filePath),
        token
    );
    const entry = LOGENTRY_RE.exec(out);
    if (!entry) {
        return undefined;
    }
    const body = entry[2];
    const dateText = pick(body, DATE_RE);
    return {
        revision: Number(entry[1]),
        author: pick(body, AUTHOR_RE) ?? '',
        date: dateText ? parseSvnDate(dateText) : undefined,
        message: (pick(body, MSG_RE) ?? '').trim()
    };
}

/** 获取某个修订号的完整日志纯文本（svn log -v） */
export async function getLogText(
    filePath: string,
    revision: number,
    token?: vscode.CancellationToken
): Promise<string> {
    return runSvn(
        ['log', '--non-interactive', '-v', '-r', String(revision), path.basename(filePath)],
        path.dirname(filePath),
        token
    );
}
