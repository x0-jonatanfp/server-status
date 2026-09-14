/**
 * Ejecucion de binarios del sistema sin shell.
 *
 * Se usa `execFile` con argumentos en lista, nunca `shell: true`: los valores
 * que vienen del inventario o de un comando de Discord (una IP, por ejemplo) no
 * pueden acabar interpretados por un shell.
 */
import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr?: string;
}

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<ExecResult>;

/**
 * Implementacion por defecto. Si el binario falla, el error rechazado conserva
 * `stdout` y `stderr`: hay herramientas (smartctl) que salen con codigo distinto
 * de cero y aun asi devuelven la informacion en la salida.
 */
export const defaultExec: ExecFileFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: options.timeout, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

/** Extrae la salida de un error de `execFile` (vacia si no la trae). */
export function stdoutOf(error: unknown): string {
  const stdout = (error as { stdout?: unknown }).stdout;
  return typeof stdout === "string" ? stdout : "";
}
