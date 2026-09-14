/**
 * Lectura de temperaturas de discos SATA con `smartctl -j -A -d sat`.
 *
 * Se llama sin shell y, si el binario no puede abrir el disco, se reintenta con
 * `sudo -n` (la regla NOPASSWD para `/usr/sbin/smartctl` ya existe); si aun asi
 * falla, el sensor sale N/A. En esta maquina el primer intento funciona porque
 * el usuario del servicio esta en el grupo `disk`, asi que el reintento no
 * cuesta nada y cubre el caso contrario.
 */
import type { TemperatureSensor } from "../../domain/entities/inventory.ts";
import { defaultExec, stdoutOf, type ExecFileFn } from "../exec.ts";

export const DEFAULT_SMARTCTL_PATH = "/usr/sbin/smartctl";
export const DEFAULT_SUDO_PATH = "/usr/bin/sudo";
const DEFAULT_TIMEOUT_MS = 5000;

export interface SmartctlTemperatureReader {
  /** Grados del disco, o `null` si no se puede leer (nunca lanza). */
  read(sensor: TemperatureSensor): Promise<number | null>;
}

export interface SmartctlTemperatureReaderOptions {
  smartctlPath?: string;
  sudoPath?: string;
  timeoutMs?: number;
  exec?: ExecFileFn;
}

export function createSmartctlTemperatureReader(
  options: SmartctlTemperatureReaderOptions = {},
): SmartctlTemperatureReader {
  const setup = {
    exec: options.exec ?? defaultExec,
    smartctlPath: options.smartctlPath ?? DEFAULT_SMARTCTL_PATH,
    sudoPath: options.sudoPath ?? DEFAULT_SUDO_PATH,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  return {
    read: (sensor) => (sensor.device ? readDevice(sensor.device, setup) : Promise.resolve(null)),
  };
}

interface SmartctlSetup {
  exec: ExecFileFn;
  smartctlPath: string;
  sudoPath: string;
  timeoutMs: number;
}

async function readDevice(device: string, setup: SmartctlSetup): Promise<number | null> {
  const args = ["-j", "-A", "-d", "sat", device];

  const direct = await runSmartctl(setup.exec, setup.smartctlPath, args, setup.timeoutMs);
  if (direct !== null) return direct;

  const viaSudo = await runSmartctl(
    setup.exec,
    setup.sudoPath,
    ["-n", setup.smartctlPath, ...args],
    setup.timeoutMs,
  );
  return viaSudo;
}

/**
 * Ejecuta smartctl y saca la temperatura del JSON. smartctl sale con codigo
 * distinto de cero cuando alguna comprobacion falla aunque el JSON venga
 * completo, asi que se intenta parsear la salida tambien en ese caso.
 */
async function runSmartctl(
  exec: ExecFileFn,
  file: string,
  args: string[],
  timeout: number,
): Promise<number | null> {
  let stdout: string;
  try {
    ({ stdout } = await exec(file, args, { timeout }));
  } catch (error) {
    stdout = stdoutOf(error);
  }

  if (stdout.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null) return null;
    const temperature = (parsed as { temperature?: { current?: unknown } }).temperature;
    const current = temperature?.current;
    return typeof current === "number" ? current : null;
  } catch {
    return null;
  }
}
