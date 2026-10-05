/*import * as fs from "fs";

export function instrumentBatch(path: string): string {
    const original = fs.readFileSync(path, "utf8").split(/\r?\n/);
    // Incluimos @echo off al inicio para ocultar las rutas de CMD
    const out: string[] = ["@echo off"];

    for (let i = 0; i < original.length; i++) {
        out.push(`echo __TRACE__LINE:${i + 1}`);
        out.push(original[i]);
    }

    const inst = path + ".instrumented.bat";
    fs.writeFileSync(inst, out.join("\r\n"));
    return inst;
}*/
import * as fs from 'fs';
import Parser from 'tree-sitter';

/*
Evita que TypeScript convierta import() en require()
cuando el proyecto se compila como CommonJS.
*/
const nativeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

export async function instrumentBatch(path: string): Promise<string> {
    const originalCode = fs.readFileSync(path, 'utf8');
    const lines = originalCode.split(/\r?\n/);

    const batchModule = await nativeImport('tree-sitter-batch');
    const Batch = batchModule.default ?? batchModule;

    const parser = new Parser();
    parser.setLanguage(Batch);
    const tree = parser.parse(originalCode);

    console.log(tree.rootNode.toString());

    const linesToInstrument = new Set<number>();
    const batchVariableNames = new Set<string>();

    // Función recursiva para recorrer todo el árbol 
    function visit(node: Parser.SyntaxNode): void {
        if (!node.isMissing) {
            // Detectamos las asignaciones de variables
            if (node.type === 'variable_assignment') {
                linesToInstrument.add(node.startPosition.row);

                for (const child of node.children) {
                    if (child.type === 'variable_name') {
                        const variableName = originalCode.slice(child.startIndex, child.endIndex).trim();

                        if (variableName.length > 0) {
                            batchVariableNames.add(variableName);
                        }
                    }

                    if (child.type === 'arithmetic_assignment') {
                        const assignmentText = originalCode.slice(child.startIndex, child.endIndex).trim();

                        const match = assignmentText.match(
                            /^\/a\s+([^=\s]+)\s*=/
                        );

                        if (match) {
                            batchVariableNames.add(match[1]);
                        }
                    }
                }
            }

            if (
                node.type === 'echo_off' ||
                node.type === 'if_stmt' ||
                node.type === 'for_stmt' ||
                node.type === 'call_stmt' ||
                node.type === 'goto_stmt' ||
                node.type === 'exit_stmt' ||
                node.type === 'setlocal_stmt' ||
                node.type === 'endlocal_stmt' ||
                node.type === 'cmd'
            ) {
                linesToInstrument.add(node.startPosition.row);
            }
        }

        for (const child of node.children) {
            visit(child);
        }
    }

    visit(tree.rootNode);

    const out: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        if (linesToInstrument.has(i)) {
            out.push(`echo __TRACE__LINE:${i + 1}`);
            out.push('@pause >nul');
        }

        if (batchVariableNames.size > 0 && i === 0) {
            for (const variableName of batchVariableNames) {
                out.push(`echo __BATCH_DEBUG_VAR__:${variableName}`);
            }
        }

        out.push(lines[i]);

        if (linesToInstrument.has(i)) {
            out.push('echo __VARS_START__');
            out.push('set');
            out.push('echo __VARS_END__');
        }
    }

    const inst = path + ".instrumented.bat";
    fs.writeFileSync(inst, out.join("\r\n"));
    return inst;    
}