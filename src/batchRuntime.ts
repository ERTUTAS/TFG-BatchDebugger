
import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { instrumentBatch } from './batchInstrumenter';
import * as fs from 'fs';

export interface FileAccessor {
	isWindows: boolean;
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, contents: Uint8Array): Promise<void>;
}

export interface IRuntimeBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

interface IRuntimeStepInTargets {
	id: number;
	label: string;
}

interface IRuntimeStackFrame {
	index: number;
	name: string;
	file: string;
	line: number;
	column?: number;
	instruction?: number;
}

interface IRuntimeStack {
	count: number;
	frames: IRuntimeStackFrame[];
}

interface RuntimeDisassembledInstruction {
	address: number;
	instruction: string;
	line?: number;
}

export type IRuntimeVariableType = number | boolean | string | RuntimeVariable[];

export class RuntimeVariable {
	private _memory?: Uint8Array;

	public reference?: number;

	public get value() {
		return this._value;
	}

	public set value(value: IRuntimeVariableType) {
		this._value = value;
		this._memory = undefined;
	}

	public get memory() {
		if (this._memory === undefined && typeof this._value === 'string') {
			this._memory = new TextEncoder().encode(this._value);
		}
		return this._memory;
	}

	constructor(public readonly name: string, private _value: IRuntimeVariableType) {}

	public setMemory(data: Uint8Array, offset = 0) {
		const memory = this.memory;
		if (!memory) {
			return;
		}

		memory.set(data, offset);
		this._memory = memory;
		this._value = new TextDecoder().decode(memory);
	}
}

interface Word {
	name: string;
	line: number;
	index: number;
}

export function timeout(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/*
Este es un entorno de ejecución simulado para el 
depurador de Batch. Se ejecuta en un subproceso separado y se 
comunica con el depurador a través de eventos.
*/
export class BatchRuntime extends EventEmitter {

	// El archivo inicial que estamos 'depurando'.
	private _sourceFile: string = '';
	public get sourceFile() {
		return this._sourceFile;
	}

	private variables = new Map<string, RuntimeVariable>();

	// El contenido (las líneas) del archivo.
	private sourceLines: string[] = [];
	private instructions: Word[] = [];
	private starts: number[] = [];
	private ends: number[] = [];

	// Esta es la siguiente línea que se 'ejecutará'.
	private _currentLine = 0;
	private get currentLine() {
		return this._currentLine;
	}
	private set currentLine(x) {
		this._currentLine = x;
		this.instruction = this.starts[x];
	}
	//private currentColumn: number | undefined;

	// Esta es la siguiente instrucción que se 'ejecutará'.
	public instruction = 0;

	// Mapa de sourceFile a un conjunto de IRuntimeBreakpoint.
	private breakPoints = new Map<string, IRuntimeBreakpoint[]>();

	// Todas las direcciones de los puntos de interrupción de instrucciones.
	private instructionBreakpoints = new Set<number>();

	// Como queremos enviar eventos de puntos de interrupción, asignaremos un ID a cada evento
	// para que la interfaz pueda asociar los eventos con los puntos de interrupción.
	private breakpointId = 1;

	private breakAddresses = new Map<string, string>();

	private namedException: string | undefined;
	private otherExceptions = false;

	private cmdProcess?: ChildProcess;
	private instrumentedPath?: string;

	// Variables para controlar la simulación del depurador
	private isStepping = false;
	private stopOnEntryRequested = false;
	private isCollectingVariables = false;
	private stdoutBuffer = '';

	// Cola de salida para procesar asíncronamente las líneas
	private outputQueue: string[] = [];
	private isPaused = false;
	private isProcessExited = false;

	constructor(private fileAccessor: FileAccessor) {
		super();
	}

	/*
	 Comenzar a ejecutar un programa.
	 */
	public async start(program: string, stopOnEntry: boolean, debug: boolean): Promise<void> {
		// Cargar archivo
    	this._sourceFile = this.normalizePathAndCasing(program);
		await this.loadSource(program);

		this.stopOnEntryRequested = stopOnEntry;
		this.isStepping = false;

		// Lanzamos el cmd.exe y que ejecute el archivo instrumentado
		this.instrumentedPath = instrumentBatch(program);
		this.cmdProcess = spawn("cmd.exe", ["/C", this.instrumentedPath]);
		
		// Escuchamos la salida estándar del CMD
		this.cmdProcess.stdout?.on('data', (data) => {
			this.handleStdout(data);;
		});

		this.cmdProcess.stderr?.on('data', (data) => {
			this.sendEvent('output', data.toString(), this._sourceFile, this.currentLine);
		});

		this.cmdProcess.on('close', () => {
			if (this.stdoutBuffer.length > 0) {
				this.outputQueue.push(this.stdoutBuffer);
				this.stdoutBuffer = '';
			}
			this.isProcessExited = true;
			this.processQueue(); // Asegurarnos de limpiar la cola antes de terminar
		});

		this.cmdProcess.on('error', (err) => {
			this.sendEvent('output', 'err', `Error en cmd.exe: ${err.message}\n`, this._sourceFile, this.currentLine);
			this.cleanupTempFile();
			this.sendEvent('end');
		});
	}

	/*
	 Procesar la salida estándar del proceso CMD.
	 */
	private handleStdout(data: Buffer | string) {
		this.stdoutBuffer += data.toString();
		const lines = this.stdoutBuffer.split(/\r?\n/);
		this.stdoutBuffer = lines.pop() ?? '';

		for (const line of lines) {
			this.outputQueue.push(line);
		}
		// Procesar la cola si el depurador no está pausado
		this.processQueue();
	}

	/*	
	 Procesar la cola de salida.
	*/
	private processQueue() {
		// Si estamos en un breakpoint o pausados, no leemos más datos
		if (this.isPaused) {
			return;
		}

		while (this.outputQueue.length > 0) {
			const line = this.outputQueue.shift()!;
			const trimmed = line.trim();

			if (trimmed.includes('__TRACE__LINE:')) {
				const rawLine = parseInt(trimmed.substring('__TRACE__LINE:'.length), 10);
				if (!isNaN(rawLine)) {
					// Convertir índice de línea del instrumentador (base 1) a base 0 del entorno
					this.currentLine = Math.max(0, rawLine - 1);

					if (this.stopOnEntryRequested) {
						this.stopOnEntryRequested = false;
						this.isPaused = true;
						this.sendEvent('stopOnEntry');
						return;
					}

					// Validar si existe un breakpoint en la línea actual
					const bps = this.breakPoints.get(this._sourceFile);
					if (bps && bps.some(bp => bp.line === this.currentLine)) {
						this.isPaused = true;
						this.sendEvent('stopOnBreakpoint');
						return;
					}

					// Detener si estamos haciendo Step / Avanzando paso a paso
					if (this.isStepping) {
						this.isStepping = false;
						this.isPaused = true;
						this.sendEvent('stopOnStep');
						return;
					}
				}
			} else {
				// Es texto impreso del script, redirigir a Debug Console
				if (line.length > 0) {
					this.sendEvent('output', 'out', line + '\n', this._sourceFile, this.currentLine, 0);
				}
			}
		}

		// Si el script ya ha finalizado su ejecución y vaciamos la cola
		if (this.isProcessExited && this.outputQueue.length === 0) {
			this.cleanupTempFile();
			this.sendEvent('end');
		}
	}

	/*
	Eliminamos el archivo temporal instrumentado si existe. Esto se llama cuando el proceso de depuración termina o se cierra.
	*/ 
	private cleanupTempFile() {
		if (this.instrumentedPath && fs.existsSync(this.instrumentedPath)) {
			try {
				fs.unlinkSync(this.instrumentedPath);
			} catch (e) {
				// Ignorar si el archivo ya fue eliminado o está bloqueado
			}
			this.instrumentedPath = undefined;
		}
	}

	/**
	 * Continuar la ejecución hasta el final o breakpoint.
	 */
	public continue() {
    	this.isStepping = false;
		this.isPaused = false;
		this.processQueue();
	}

	/**
	 * Avanzar hasta la siguiente línea no vacía.
	 */
	public step() {
		this.isStepping = true;
		this.isPaused = false;
		this.processQueue();
	}

	/*
	 * Avanzar dentro de una llamada a call.
	 */
	public stepIn(targetId: number | undefined) {
		this.step();
	}

	/*
	 * Avanzar fuera de una llamada a call.
	 */
	public stepOut() {
		this.step();
	}

	public getStepInTargets(frameId: number): IRuntimeStepInTargets[] {
	
		const line = this.getLine();
		const words = this.getWords(this.currentLine, line);

		// No devolver nada si frameId está fuera de rango.
		if (frameId < 0 || frameId >= words.length) {
			return [];
		}

		const { name, index  }  = words[frameId];

		// Convertir cada carácter del marco en un posible destino para "entrar".
		return name.split('').map((c, ix) => {
			return {
				id: index + ix,
				label: `target: ${c}`
			};
		});
	}

	/*
	 * Detener la ejecución del programa.
	 */
	public stop() {
		if (this.cmdProcess) {
			this.cmdProcess.kill();
			this.cmdProcess = undefined;
		}
		this.isPaused = true;
		this.cleanupTempFile();
	}

	/**
	 * Devuelve un 'stacktrace' en el que cada 'stackframe' es una  línea.
	 */
	public stack(startFrame: number, endFrame: number): IRuntimeStack {

		const frames: IRuntimeStackFrame[] = [{
			index: 0,
			name: `Línea ${this.currentLine + 1}`,
			file: this._sourceFile,
			line: this.currentLine,
			column: 0
		}];

		return {
			frames: frames,
			count: 1
		};
	}

	/*
	 * Determinar las posibles posiciones de columna de los puntos de interrupción para la línea indicada.
	 * Aquí devolvemos la posición inicial de las palabras con más de 8 caracteres.
	 */
	public getBreakpoints(path: string, line: number): number[] {
		return this.getWords(line, this.getLine(line)).filter(w => w.name.length > 8).map(w => w.index);
	}

	/*
	 * Establecer un punto de interrupción en el archivo y la línea indicados.
	 */
	public async setBreakPoint(path: string, line: number): Promise<IRuntimeBreakpoint> {
		path = this.normalizePathAndCasing(path);

		const bp: IRuntimeBreakpoint = { verified: true, line, id: this.breakpointId++ };
		let bps = this.breakPoints.get(path);
		if (!bps) {
			bps = new Array<IRuntimeBreakpoint>();
			this.breakPoints.set(path, bps);
		}
		bps.push(bp);

		//await this.verifyBreakpoints(path);

		return bp;
	}

	/*
	 * Borrar el punto de interrupción del archivo y la línea indicados.
	 */
	public clearBreakPoint(path: string, line: number): IRuntimeBreakpoint | undefined {
		const bps = this.breakPoints.get(this.normalizePathAndCasing(path));
		if (bps) {
			const index = bps.findIndex(bp => bp.line === line);
			if (index >= 0) {
				const bp = bps[index];
				bps.splice(index, 1);
				return bp;
			}
		}
		return undefined;
	}

	public clearBreakpoints(path: string): void {
		this.breakPoints.delete(this.normalizePathAndCasing(path));
	}

	public setDataBreakpoint(address: string, accessType: 'read' | 'write' | 'readWrite'): boolean {

		const x = accessType === 'readWrite' ? 'read write' : accessType;

		const t = this.breakAddresses.get(address);
		if (t) {
			if (t !== x) {
				this.breakAddresses.set(address, 'read write');
			}
		} else {
			this.breakAddresses.set(address, x);
		}
		return true;
	}

	public clearAllDataBreakpoints(): void {
		this.breakAddresses.clear();
	}

	public setExceptionsFilters(namedException: string | undefined, otherExceptions: boolean): void {
		this.namedException = namedException;
		this.otherExceptions = otherExceptions;
	}

	public setInstructionBreakpoint(address: number): boolean {
		this.instructionBreakpoints.add(address);
		return true;
	}

	public clearInstructionBreakpoints(): void {
		this.instructionBreakpoints.clear();
	}

	public async getGlobalVariables(cancellationToken?: () => boolean ): Promise<RuntimeVariable[]> {

		let a: RuntimeVariable[] = [];

		for (let i = 0; i < 10; i++) {
			a.push(new RuntimeVariable(`global_${i}`, i));
			if (cancellationToken && cancellationToken()) {
				break;
			}
			await timeout(1000);
		}

		return a;
	}

	public getLocalVariables(): RuntimeVariable[] {
		return Array.from(this.variables, ([name, value]) => value);
	}

	public getLocalVariable(name: string): RuntimeVariable | undefined {
		return this.variables.get(name);
	}

	/**
	 * Devolver las palabras del rango de direcciones indicado como "instrucciones".
	 */
	public disassemble(address: number, instructionCount: number): RuntimeDisassembledInstruction[] {

		const instructions: RuntimeDisassembledInstruction[] = [];

		for (let a = address; a < address + instructionCount; a++) {
			if (a >= 0 && a < this.instructions.length) {
				instructions.push({
					address: a,
					instruction: this.instructions[a].name,
					line: this.instructions[a].line
				});
			} else {
				instructions.push({
					address: a,
					instruction: 'nop'
				});
			}
		}

		return instructions;
	}

	// Métodos privados.

	private getLine(line?: number): string {
		return this.sourceLines[line === undefined ? this.currentLine : line].trim();
	}
	
	private getWords(l: number, line: string): Word[] {
		// Dividir la línea en palabras.
		const WORD_REGEXP = /[a-z]+/ig;
		const words: Word[] = [];
		let match: RegExpExecArray | null;
		while (match = WORD_REGEXP.exec(line)) {
			words.push({ name: match[0], line: l, index: match.index });
		}
		return words;
	}

	private async loadSource(file: string): Promise<void> {
		if (this._sourceFile !== file) {
			this._sourceFile = this.normalizePathAndCasing(file);
			this.initializeContents(await this.fileAccessor.readFile(file));
		}
	}

	private initializeContents(memory: Uint8Array) {
		const rawContent = new TextDecoder().decode(memory);
    
    	this.sourceLines = rawContent.split(/\r?\n/); 

		this.starts = [];
		this.instructions = [];
		this.ends = [];

		for (let l = 0; l < this.sourceLines.length; l++) {
			this.starts.push(this.instructions.length);
			const words = this.getWords(l, this.sourceLines[l]);
			for (let word of words) {
				this.instructions.push(word);
			}
			this.ends.push(this.instructions.length);
		}
	}

	/**
	 * Devuelve true cuando se detiene la ejecución.
	 */
	 private findNextStatement(reverse: boolean, stepEvent?: string): boolean {

		for (let ln = this.currentLine; reverse ? ln >= 0 : ln < this.sourceLines.length; reverse ? ln-- : ln++) {

			// ¿Hay un punto de interrupción en el código fuente?
			const breakpoints = this.breakPoints.get(this._sourceFile);
			if (breakpoints) {
				const bps = breakpoints.filter(bp => bp.line === ln);
				if (bps.length > 0) {

					// Enviar el evento 'stopped'.
					this.sendEvent('stopOnBreakpoint');

					// Lo siguiente muestra cómo utilizar eventos de 'breakpoint' para actualizar las propiedades de un punto de interrupción en la interfaz.
					// Si el punto de interrupción aún no está verificado, verificarlo ahora y enviar un evento de actualización 'breakpoint'.
					if (!bps[0].verified) {
						bps[0].verified = true;
						this.sendEvent('breakpointValidated', bps[0]);
					}

					this.currentLine = ln;
					return true;
				}
			}

			const line = this.getLine(ln);
			if (line.length > 0) {
				this.currentLine = ln;
				break;
			}
		}
		if (stepEvent) {
			this.sendEvent(stepEvent);
			return true;
		}
		return false;
	}

	/**
	 * "Ejecutar una línea" del Markdown del archivo.
	 * Devuelve true si la ejecución ha enviado un evento de parada y debe detenerse.
	 */
	private executeLine(ln: number, reverse: boolean): boolean {

		// Primero "ejecutar" las instrucciones asociadas a esta línea y comprobar si se alcanza algún punto de interrupción de instrucciones.
		while (reverse ? this.instruction >= this.starts[ln] : this.instruction < this.ends[ln]) {
			reverse ? this.instruction-- : this.instruction++;
			if (this.instructionBreakpoints.has(this.instruction)) {
				this.sendEvent('stopOnInstructionBreakpoint');
				return true;
			}
		}

		const line = this.getLine(ln);

		if (line.length > 0) {
			// Enviar la línea real del script .bat al cmd.exe
			this.cmdProcess?.stdin?.write(`${line}\r\n`);
			
			// Pedir un volcado de variables usando 'set' y enviar una marca de texto para saber cuándo termina
			//this.isCollectingVariables = true;
			//this.outputBuffer = "";
			// Retornamos true para detener la ejecución sincrónica de Node, 
			// ya que ahora dependemos del evento asíncrono 'data' del stdout para continuar.
			return true; 
		}

		// No se ha encontrado nada relevante: continuar.
		return false;
	}

	private async verifyBreakpoints(path: string): Promise<void> {

		const bps = this.breakPoints.get(path);
		if (bps) {
			await this.loadSource(path);
			bps.forEach(bp => {
				if (!bp.verified && bp.line < this.sourceLines.length) {
					const srcLine = this.getLine(bp.line);

					// Si una línea está vacía o empieza por '+', no permitimos establecer un punto de interrupción y lo desplazamos hacia abajo.
					if (srcLine.length === 0 || srcLine.indexOf('+') === 0) {
						bp.line++;
					}
					// Si una línea empieza por '-', no permitimos establecer un punto de interrupción y lo desplazamos hacia arriba.
					if (srcLine.indexOf('-') === 0) {
						bp.line--;
					}
					// No establecer 'verified' en true si la línea contiene la palabra 'lazy'.
					// En este caso, el punto de interrupción se verificará de forma 'lazy' después de alcanzarlo una vez.
					if (srcLine.indexOf('lazy') < 0) {
						bp.verified = true;
						this.sendEvent('breakpointValidated', bp);
					}
				}
			});
		}
	}

	private sendEvent(event: string, ... args: any[]): void {
		setTimeout(() => {
			this.emit(event, ...args);
		}, 0);
	}

	private normalizePathAndCasing(path: string) {
		if (this.fileAccessor.isWindows) {
			return path.replace(/\//g, '\\').toLowerCase();
		} else {
			return path.replace(/\\/g, '/');
		}
	}
}