import * as vscode from 'vscode';
import { AnnotationController } from './annotation';
import { blameService } from './blameService';
import { escapeMarkdown, formatDate } from './util';

export class SvnHoverProvider implements vscode.HoverProvider {
    constructor(private readonly annotation?: AnnotationController) { }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        const cfg = vscode.workspace.getConfiguration('svnBlame');
        if (!cfg.get<boolean>('enabled', true)) {
            return undefined;
        }
        if (document.uri.scheme !== 'file' || !blameService.isTracked(document.uri.fsPath)) {
            return undefined;
        }

        const result = await blameService.getBlame(document.uri, token);
        if (token.isCancellationRequested) {
            return undefined;
        }
        if (!result) {
            // 不在工作副本内时保持静默；工作副本内但 svn 调用失败时给出原因，便于排查
            const reason = blameService.lastError(document.uri.fsPath);
            if (!reason) {
                return undefined;
            }
            const err = new vscode.MarkdownString();
            err.supportThemeIcons = true;
            err.appendMarkdown('$(error) **获取 SVN 信息失败**\n\n');
            err.appendCodeblock(reason, 'text');
            err.appendMarkdown('\n\n请检查设置 `svnBlame.svnPath`，或运行命令 **SVN Blame: 诊断当前文件**（输出面板会显示详细信息）。');
            return new vscode.Hover(err, document.lineAt(position.line).range);
        }

        const line = result.getLine(position.line + 1);
        if (!line) {
            this.annotation?.clearHover();
            const empty = new vscode.MarkdownString('_该行没有 SVN 提交信息_');
            return new vscode.Hover(empty, document.lineAt(position.line).range);
        }

        // 鼠标悬停时，在该行末尾直接显示提交信息
        this.annotation?.showHoverLine(document, position.line, result);

        const dateFormat = cfg.get<string>('dateFormat', 'YYYY-MM-DD HH:mm');
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.supportThemeIcons = true;

        if (line.local) {
            md.appendMarkdown('$(diff-modified) **本地未提交的修改**\n\n');
            md.appendMarkdown('_该行尚未提交到 SVN，暂无提交信息。_');
            return new vscode.Hover(md, document.lineAt(position.line).range);
        }

        const author = escapeMarkdown(line.author || '未知');
        const dateText = line.date ? formatDate(line.date, dateFormat) : '未知时间';
        md.appendMarkdown(`$(git-commit) **r${line.revision}** · $(person) **${author}** · $(history) ${escapeMarkdown(dateText)}\n\n`);

        if (cfg.get<boolean>('hover.showCommitMessage', true)) {
            const commit = await blameService.getCommit(document.uri.fsPath, line.revision, token);
            if (token.isCancellationRequested) {
                return undefined;
            }
            if (commit?.message) {
                const maxLines = Math.max(1, cfg.get<number>('hover.messageMaxLines', 20));
                const all = commit.message.split(/\r?\n/);
                const shown = all.slice(0, maxLines);
                let text = shown.join('\n');
                if (all.length > maxLines) {
                    text += `\n… 省略 ${all.length - maxLines} 行`;
                }
                md.appendCodeblock(text, 'text');
                md.appendMarkdown('\n\n');
            } else {
                md.appendMarkdown('_（无提交日志）_\n\n');
            }
        }

        const arg = encodeURIComponent(JSON.stringify({ fsPath: document.uri.fsPath, revision: line.revision }));
        md.appendMarkdown(`---\n\n[$(list-unordered) 查看完整日志 (r${line.revision})](command:svnBlame.showLog?${arg})`);

        return new vscode.Hover(md, document.lineAt(position.line).range);
    }
}
