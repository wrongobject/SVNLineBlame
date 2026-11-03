import * as vscode from 'vscode';
import { blameService, BlameResult } from './blameService';
import { BlameLine } from './svn';
import { formatDate, relativeTime } from './util';

/** 超过该行数的文件不做全量行内注解，避免卡顿 */
const MAX_ANNOTATION_LINES = 8000;

/** 鼠标移开后隐藏悬停注解的兜底时间（VS Code 没有 hover 结束事件） */
const HOVER_HIDE_DELAY = 8000;

/** 一次最多为多少行选中区域显示注解 */
const MAX_SELECTION_LINES = 200;

export class AnnotationController implements vscode.Disposable {
    private readonly decoration: vscode.TextEditorDecorationType;
    private readonly hoverDecoration: vscode.TextEditorDecorationType;
    private readonly selectionDecoration: vscode.TextEditorDecorationType;
    private readonly statusBar: vscode.StatusBarItem;
    private readonly rendered = new Map<string, string>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private hoverTimer: ReturnType<typeof setTimeout> | undefined;
    private hoverEditor: vscode.TextEditor | undefined;
    private selectionEditor: vscode.TextEditor | undefined;
    private readonly selectionLines = new Set<number>();
    private disposed = false;

    constructor() {
        this.decoration = vscode.window.createTextEditorDecorationType({
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
            after: {
                margin: '0 0 0 3em',
                color: 'rgba(160,160,160,0.8)',
                fontStyle: 'italic'
            }
        });
        // 鼠标悬停时用于「在当前行显示提交信息」的注解
        this.hoverDecoration = vscode.window.createTextEditorDecorationType({
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
            backgroundColor: new vscode.ThemeColor('editor.hoverHighlightBackground'),
            after: {
                margin: '0 0 0 2em',
                color: new vscode.ThemeColor('editorCodeLens.foreground'),
                fontStyle: 'italic'
            }
        });
        // 鼠标点击/光标移动时，在选中行末尾显示提交信息
        this.selectionDecoration = vscode.window.createTextEditorDecorationType({
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
            after: {
                margin: '0 0 0 2em',
                color: new vscode.ThemeColor('editorCodeLens.foreground'),
                fontStyle: 'italic'
            }
        });
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
        this.statusBar.name = 'SVN Blame';
        this.statusBar.command = 'svnBlame.showLog';
        this.statusBar.tooltip = '当前行的 SVN 提交信息（点击查看完整日志）';
    }

    /** 触发一次防抖刷新 */
    refresh(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor): void {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            void this.apply(editor);
        }, 120);
    }

    private async apply(editor: vscode.TextEditor | undefined): Promise<void> {
        if (this.disposed || !editor) {
            this.statusBar.hide();
            return;
        }
        const cfg = vscode.workspace.getConfiguration('svnBlame');
        const enabled = cfg.get<boolean>('enabled', true);
        const inlineEnabled = cfg.get<boolean>('inline.enabled', false);
        const statusEnabled = cfg.get<boolean>('statusBar.enabled', false);
        const selectionEnabled = cfg.get<boolean>('selection.enabled', true);
        const document = editor.document;

        if (!enabled || document.uri.scheme !== 'file') {
            this.clearDecorations(editor);
            this.clearSelection();
            this.statusBar.hide();
            return;
        }

        // 常驻/跟随开关都关闭时，不执行任何 svn 命令（此时只在鼠标悬停时查询）
        if (!inlineEnabled && !statusEnabled && !selectionEnabled) {
            this.clearDecorations(editor);
            this.clearSelection();
            this.statusBar.hide();
            return;
        }

        const result = await blameService.getBlame(document.uri);
        if (this.disposed || vscode.window.activeTextEditor !== editor) {
            return;
        }

        if (!result) {
            this.clearDecorations(editor);
            this.clearSelection();
            this.statusBar.hide();
            return;
        }

        const template = cfg.get<string>('inline.template', '${author} · r${revision} · ${date}');
        const dateFormat = cfg.get<string>('dateFormat', 'YYYY-MM-DD HH:mm');

        // 选中行：鼠标点击或光标移动时在选中行末尾显示该行的提交信息
        if (selectionEnabled && !inlineEnabled) {
            this.applySelection(editor, result, template, dateFormat);
        } else {
            this.clearSelection();
        }

        // 行内注解（常驻）
        if (inlineEnabled) {
            const mode = cfg.get<'allLines' | 'currentLine'>('inline.mode', 'allLines');
            const signature = `${document.uri.fsPath}|${document.version}|${mode}`;
            if (this.rendered.get(editor.document.uri.fsPath) !== signature) {
                this.rendered.set(document.uri.fsPath, signature);
                const options = this.buildOptions(editor, mode, result, template);
                editor.setDecorations(this.decoration, options);
            }
        } else {
            this.clearDecorations(editor);
        }

        // 状态栏
        if (statusEnabled) {
            const line = result.getLine(editor.selection.active.line + 1);
            if (line) {
                this.statusBar.text = this.renderLine(line, '$(git-commit) ${author} · r${revision} · ${date}', dateFormat);
                this.statusBar.show();
            } else {
                this.statusBar.hide();
            }
        } else {
            this.statusBar.hide();
        }
    }

    /** 鼠标点击或光标移动时，在选中行末尾显示该行的提交信息 */
    private applySelection(
        editor: vscode.TextEditor,
        result: BlameResult,
        template: string,
        dateFormat: string
    ): void {
        if (this.selectionEditor && this.selectionEditor !== editor) {
            this.selectionEditor.setDecorations(this.selectionDecoration, []);
        }

        const options: vscode.DecorationOptions[] = [];
        this.selectionLines.clear();
        for (const lineNo of this.selectedLines(editor)) {
            const line = result.getLine(lineNo + 1);
            if (!line) {
                continue;
            }
            const pos = editor.document.lineAt(lineNo).range.end;
            options.push({
                range: new vscode.Range(pos, pos),
                renderOptions: { after: { contentText: ` ${this.renderLine(line, template, dateFormat)}` } }
            });
            this.selectionLines.add(lineNo);
        }

        editor.setDecorations(this.selectionDecoration, options);
        this.selectionEditor = editor;
    }

    /** 当前所有选区覆盖的行号（0 起） */
    private selectedLines(editor: vscode.TextEditor): Set<number> {
        const lines = new Set<number>();
        for (const sel of editor.selections) {
            if (sel.isEmpty) {
                lines.add(sel.active.line);
            } else {
                for (let i = sel.start.line; i <= sel.end.line && lines.size < MAX_SELECTION_LINES; i++) {
                    lines.add(i);
                }
            }
            if (lines.size >= MAX_SELECTION_LINES) {
                break;
            }
        }
        return lines;
    }

    private clearSelection(): void {
        if (this.selectionEditor) {
            if (!this.selectionEditor.document.isClosed) {
                this.selectionEditor.setDecorations(this.selectionDecoration, []);
            }
            this.selectionEditor = undefined;
        }
        this.selectionLines.clear();
    }

    /**
     * 鼠标悬停到某一行时，在该行末尾直接显示该行的 SVN 提交信息。
     * 由 HoverProvider 在悬停时调用：不悬停不显示，也不需要任何菜单或命令触发。
     */
    showHoverLine(document: vscode.TextDocument, lineNo: number, result: BlameResult): void {
        if (this.disposed) {
            return;
        }
        const cfg = vscode.workspace.getConfiguration('svnBlame');
        if (!cfg.get<boolean>('hover.inline', true)) {
            return;
        }
        const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
        if (!editor) {
            return;
        }

        const line = result.getLine(lineNo + 1);
        if (!line) {
            this.clearHover();
            return;
        }

        // 选中行已经显示了同样的信息，避免同一行出现两段重复文字
        if (this.selectionLines.has(lineNo)) {
            return;
        }

        const template = cfg.get<string>('inline.template', '${author} · r${revision} · ${date}');
        const text = this.renderLine(line, template, cfg.get<string>('dateFormat', 'YYYY-MM-DD HH:mm'));
        const pos = document.lineAt(lineNo).range.end;
        editor.setDecorations(this.hoverDecoration, [{
            range: new vscode.Range(pos, pos),
            renderOptions: { after: { contentText: ` ${text}` } }
        }]);
        this.hoverEditor = editor;

        if (this.hoverTimer) {
            clearTimeout(this.hoverTimer);
        }
        this.hoverTimer = setTimeout(() => this.clearHover(), HOVER_HIDE_DELAY);
    }

    /** 清除悬停注解（鼠标移开一段时间后自动调用） */
    clearHover(): void {
        if (this.hoverTimer) {
            clearTimeout(this.hoverTimer);
            this.hoverTimer = undefined;
        }
        if (this.hoverEditor && !this.hoverEditor.document.isClosed) {
            this.hoverEditor.setDecorations(this.hoverDecoration, []);
        }
        this.hoverEditor = undefined;
    }

    private buildOptions(
        editor: vscode.TextEditor,
        mode: 'allLines' | 'currentLine',
        result: BlameResult,
        template: string
    ): vscode.DecorationOptions[] {
        const cfg = vscode.workspace.getConfiguration('svnBlame');
        const dateFormat = cfg.get<string>('dateFormat', 'YYYY-MM-DD HH:mm');
        const options: vscode.DecorationOptions[] = [];
        const document = editor.document;

        if (mode === 'currentLine') {
            const lineNo = editor.selection.active.line + 1;
            const line = result.getLine(lineNo);
            if (line) {
                options.push(this.toOption(document, line, template, dateFormat));
            }
            return options;
        }

        const max = Math.min(document.lineCount, MAX_ANNOTATION_LINES);
        for (let i = 0; i < max; i++) {
            const line = result.getLine(i + 1);
            if (!line) {
                continue;
            }
            options.push(this.toOption(document, line, template, dateFormat));
        }
        return options;
    }

    private toOption(
        document: vscode.TextDocument,
        line: BlameLine,
        template: string,
        dateFormat: string
    ): vscode.DecorationOptions {
        const pos = document.lineAt(line.line - 1).range.end;
        return {
            range: new vscode.Range(pos, pos),
            renderOptions: { after: { contentText: ` ${this.renderLine(line, template, dateFormat)}` } }
        };
    }

    private renderLine(line: BlameLine, template: string, dateFormat: string): string {
        if (line.local) {
            return '本地未提交';
        }
        return template
            .replace(/\$\{author\}/g, line.author || '未知')
            .replace(/\$\{revision\}/g, String(line.revision))
            .replace(/\$\{date\}/g, line.date ? formatDate(line.date, dateFormat) : '未知时间')
            .replace(/\$\{relativeTime\}/g, line.date ? relativeTime(line.date) : '未知时间');
    }

    private clearDecorations(editor: vscode.TextEditor): void {
        editor.setDecorations(this.decoration, []);
        this.rendered.delete(editor.document.uri.fsPath);
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.clearHover();
        this.clearSelection();
        this.decoration.dispose();
        this.hoverDecoration.dispose();
        this.selectionDecoration.dispose();
        this.statusBar.dispose();
        this.rendered.clear();
    }
}
