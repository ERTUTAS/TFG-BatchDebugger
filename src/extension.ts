// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { BatchDebugSession } from './batchDebug';
import { FileAccessor } from './batchRuntime';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "batch-debugger" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('batch-debugger.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from Batch Debugger!');
	});

	// Registrar el proveedor de configuración para el tipo "batch"
	const provider = new BatchConfigurationProvider();
	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider('bat', provider)
	);
	//Registrar la fábrica para instanciar el adaptador de depuración
	const factory = new InlineDebugAdapterFactory();
	const factoryRegistration =
    vscode.debug.registerDebugAdapterDescriptorFactory('bat', factory);

	context.subscriptions.push(factoryRegistration);
	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}

/**
 * Resuelve y valida la configuración de depuración antes de iniciar la sesión.
 */
class BatchConfigurationProvider implements vscode.DebugConfigurationProvider {

    /*
	* Ajustar una configuración de depuración justo antes de iniciar una sesión,
	* por ejemplo, añadiendo todos los atributos que falten a la configuración.
	*/

	resolveDebugConfiguration(
		folder: vscode.WorkspaceFolder | undefined,
		config: vscode.DebugConfiguration,
		token?: vscode.CancellationToken
	): vscode.ProviderResult<vscode.DebugConfiguration> {

		// Si no hay un launch.json y el usuario pulsa F5 directamente en un archivo .bat
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && (editor.document.languageId === 'bat' || editor.document.fileName.endsWith('.bat') || editor.document.fileName.endsWith('.cmd'))) {
				config.type = 'bat';
				config.name = 'Launch';
				config.request = 'launch';
				config.program = '${file}';
				config.stopOnEntry = true;
			}
		}

		// Si no se ha especificado una ruta de programa, muestra un aviso y cancela la sesión
		if (!config.program) {
			return vscode.window.showInformationMessage("No se ha encontrado ningún archivo para depurar.").then(_ => {
				return undefined; // Cancela la depuración
			});
		}

		return config;
	}
}

/**
 * Crea una instancia ejecutable en línea (inline) de tu adaptador de depuración BatchDebugSession.
 */
class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
		// Instancia directa del adaptador que definiste en batchDebug.ts
		return new vscode.DebugAdapterInlineImplementation(new BatchDebugSession(workspaceFileAccessor));
	}
}

export const workspaceFileAccessor: FileAccessor = {
	isWindows: typeof process !== 'undefined' && process.platform === 'win32',
	async readFile(path: string): Promise<Uint8Array> {
		let uri: vscode.Uri;
		try {
			uri = pathToUri(path);
		} catch (e) {
			return new TextEncoder().encode(`cannot read '${path}'`);
		}

		return await vscode.workspace.fs.readFile(uri);
	},
	async writeFile(path: string, contents: Uint8Array) {
		await vscode.workspace.fs.writeFile(pathToUri(path), contents);
	}
};

function pathToUri(path: string) {
	try {
		return vscode.Uri.file(path);
	} catch (e) {
		return vscode.Uri.parse(path);
	}
}