import * as fs from "fs";

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
}
