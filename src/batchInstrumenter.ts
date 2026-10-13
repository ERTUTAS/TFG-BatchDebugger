
import * as fs from 'fs';
import Parser from 'tree-sitter';

const INSTRUMENTABLE_NODES = new Set([
    'variable_assignment',
    'echo_off',
    'if_stmt',
    'for_stmt',
    'call_stmt',
    'goto_stmt',
    'exit_stmt',
    'setlocal_stmt',
    'endlocal_stmt',
    'cmd'
]);

export const DEBUG_VAR: string = '__BATCH_DEBUG_VAR__';
export const TRACE_LINE: string = '__TRACE_LINE__';
export const VARS_START: string = '__VARS_START__';
export const VARS_END: string = '__VARS_END__';

/*
Evita que TypeScript convierta import() en require()
cuando el proyecto se compila como CommonJS.
*/
const nativeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;


/**
 * Instrumenta un archivo .bat para facilitar su depuración
 *
 * @param path Path de archivo .bat
 * @returns Archivo .bat modificado para facilitar su depuracion
 */
export async function instrumentBatch(path: string): Promise<string> {
    const originalCode = fs.readFileSync(path, 'utf8');
    const lines = originalCode.split(/\r?\n/);

    // Creacion del parser de Tree-sitter para Batch
    const batchModule = await nativeImport('tree-sitter-batch');
    const Batch = batchModule.default ?? batchModule;

    const parser = new Parser();
    parser.setLanguage(Batch);
    const tree = parser.parse(originalCode);

    // Muestra arbol en consola para comprobacion
    console.log(tree.rootNode.toString());

    // Conjuntos para almacenar las lineas a instrumentar y los nombres de variables
    const linesToInstrument = new Set<number>();
    const batchVariableNames = new Set<string>();

    visitAst(tree.rootNode, originalCode, linesToInstrument, batchVariableNames);

    const out: string[] = [];

    // Hace un echo de todas las variables detectadas en el script completo al inicio
    if (batchVariableNames.size > 0 ) {
        for (const variableName of batchVariableNames) {
            out.push(`@echo ${DEBUG_VAR}:${variableName}`);
        }
    }

    for (let i = 0; i < lines.length; i++) {
        // Si nos encontramos una linea hacemos echo para indicar el numero de linea
        // y hacemos un pause para que el runtime pueda usar breakpoints
        if (linesToInstrument.has(i)) {
            out.push(`@echo ${TRACE_LINE}:${i + 1}`);
            out.push('@pause >nul');
        }

        out.push(lines[i]);

        // Tras escribir cada linea para que se ejecute de normal, añadimos un bloque
        // que muestra todas las variables para controlar si alguna de las declaradas ha
        // cambiado valor y así poder añadirla en el map de depuradores en el runtime
        if (linesToInstrument.has(i)) {
            out.push(`@echo ${VARS_START}`);
            out.push('@set');
            out.push(`@echo ${VARS_END}`);
        }
    }

    const inst = path + ".instrumented.bat";
    fs.writeFileSync(inst, out.join("\r\n"));
    return inst;    
}

/**
 * Visita los nodos del AST y determina qué líneas instrumentar y qué variables extraer
 *
 * @param node Nodo del AST
 * @param originalCode Codigo batch
 * @param linesToInstrument Conjunto de líneas a instrumentar
 * @param batchVariableNames Conjunto de nombres de variables
 */
function visitAst(node: Parser.SyntaxNode, originalCode: string,
    linesToInstrument: Set<number>, batchVariableNames: Set<string>): void {

    if (!node.isMissing) {
        if (INSTRUMENTABLE_NODES.has(node.type)) {
            linesToInstrument.add(node.startPosition.row);
        }

        extractVariables(node, originalCode, batchVariableNames);
    }

    for (const child of node.children) {
        visitAst(child, originalCode, linesToInstrument, batchVariableNames);
    }
}

/**
 * Extrae del nodo del AST en caso de que el tipo sea de asignacion de variable, el nombre
 * de la variable y lo añade al conjunto de nombres de variables batchVariableNames
 *
 * @param node Nodo del AST del que se extrae la variable
 * @param originalCode Codigo batch
 * @param batchVariableNames Conjunto de nombres de variables
 */
function extractVariables(node: Parser.SyntaxNode, originalCode: string, batchVariableNames: Set<string>): void {
    if (node.type !== 'variable_assignment') { return; }

    for (const child of node.children) {
        if (child.type === 'variable_name') {
            const variableName = originalCode.slice(child.startIndex, child.endIndex).trim();

            if (variableName.length > 0) {
                batchVariableNames.add(variableName);
            }
        }
        else if (child.type === 'arithmetic_assignment') {
            const assignmentText = originalCode.slice(child.startIndex, child.endIndex).trim();
            // TODO que funcione cuando se hace un set aritmetico con varios valores
            // Ejemplo: set /a var1=var2,var3=var3
            const match = assignmentText.match(
                /^\/a\s+([^=\s]+)\s*=/
            );

            if (match) {
                batchVariableNames.add(match[1]);
            }
        }
    }
}