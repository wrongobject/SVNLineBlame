import * as vscode from 'vscode';
import { AnnotationController } from './annotation';
import { blameService } from './blameService';
import { SvnHoverProvider } from './hover';

let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
    outputChannel = vscode.window.createOutputChannel('SVN Blame');
    const controller = new AnnotationController();

    context.subscriptions.push(
        outputChannel,
        controller,
        vscode.languages.registerHoverProvider({ scheme: 'file' }, new SvnHoverProvider(controller)),

        vscode.window.onDidChangeActiveTextEditor(editor => {
            controller.clearHover();
            controller.refresh(editor);
        }),
        vscode.window.onDidChangeTextEditorSelection(e => controller.refresh(e.textEditor)),
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.scheme === 'file' && e.contentChanges.length > 0) {
                controller.clearHover();
                controller.refresh();
            }
        }),
        vscode.workspace.onDidSaveTextDocument(document => {
            if (document.uri.scheme !== 'file') {
                return;
            }
            blameService.invalidate(document.uri.fsPath);
            controller.refresh();
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            blameService.invalidate(document.uri.fsPath);
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('svnBlame')) {
                blameService.clear();
                controller.refresh();
            }
        }),

        vscode.commands.registerCommand('svnBlame.toggleInline', async () => {
            const cfg = vscode.workspace.getConfiguration('svnBlame');
            const current = cfg.get<boolean>('inline.enabled', true);
            await cfg.update('inline.enabled', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`SVN 行内注解已${!current ? '开启' : '关闭'}`);
        }),

        vscode.commands.registerCommand('svnBlame.refresh', () => {
            blameService.clear();
            controller.refresh();
            vscode.window.showInformationMessage('SVN Blame 缓存已刷新');
        }),

        vscode.commands.registerCommand('svnBlame.showLog',
            (args?: { fsPath?: string; revision?: number }) => showLog(args)),

        vscode.commands.registerCommand('svnBlame.diagnose', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.uri.scheme !== 'file') {
                vscode.window.showInformationMessage('请先打开一个本地文件再运行诊断');
                return;
            }
            const text = await blameService.diagnose(editor.document.uri.fsPath);
            outputChannel.clear();
            outputChannel.appendLine(text);
            outputChannel.show(true);
        })
    );

    controller.refresh();
}

async function showLog(args?: { fsPath?: string; revision?: number }): Promise<void> {
    let fsPath = args?.fsPath;
    let revision = args?.revision;

    if (!fsPath || revision === undefined) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') {
            vscode.window.showInformationMessage('请先在 SVN 版本控制的文件中定位到某一行');
            return;
        }
        fsPath = editor.document.uri.fsPath;
        const result = await blameService.getBlame(editor.document.uri);
        const line = result?.getLine(editor.selection.active.line + 1);
        if (!line || line.local) {
            vscode.window.showInformationMessage('当前行没有可用的 SVN 提交信息');
            return;
        }
        revision = line.revision;
    }

    try {
        const text = await blameService.getLog(fsPath, revision);
        outputChannel.clear();
        outputChannel.appendLine(text.trim() || `r${revision} 没有日志信息`);
        outputChannel.show(true);
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`获取 r${revision} 日志失败：${reason}`);
        outputChannel.show(true);
        vscode.window.showErrorMessage(`获取 SVN 日志失败：${reason}`);
    }
}

export function deactivate(): void {
    blameService.clear();
}
