/**
 * Temperaturas de todos los sensores del inventario.
 *
 * Dos fuentes, ninguna de las cuales depende de `systeminformation` (en esta
 * maquina no expone la temperatura de la GPU AMD):
 *
 * - `hwmon`: se lee `/sys/class/hwmon`, que es la interfaz estable del kernel y
 *   no necesita privilegios. Cubre CPU, GPU, NVMe y placa base.
 * - `smartctl -j`: para los discos SATA, que no exponen temperatura por hwmon.
 *   Se llama sin shell y, si el binario no puede abrir el disco, se reintenta
 *   con `sudo -n` (la regla NOPASSWD para `/usr/sbin/smartctl` ya existe); si
 *   aun asi falla, el sensor sale N/A.
 *
 * Todas las lecturas fuera del rango 1-120 C se descartan: el `it8792` de esta
 * placa expone un termistor desconectado que reporta -55 C y el NVMe declara
 * maximos de 65261 C. Sin ese filtro el mensaje mostraria basura.
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { TemperatureConfig, TemperatureSource } from "../config.ts";

/** Rango valido de una lectura de temperatura, en grados centigrados. */
export const MIN_VALID_CELSIUS = 1;
export const MAX_VALID_CELSIUS = 120;

const DEFAULT_HWMON_ROOT = "/sys/class/hwmon";
const DEFAULT_SMARTCTL_PATH = "/usr/sbin/smartctl";
const DEFAULT_SUDO_PATH = "/usr/bin/sudo";
const DEFAULT_TIMEOUT_MS = 5000;

export interface TemperatureReading {
  /** Etiqueta que se muestra en el mensaje (CPU, GPU, NVMe, Placa...). */
  name: string;
  /** `null` si la fuente falla o la lectura es imposible. */
  celsius: number | null;
  warn: number;
  crit: number;
  source: TemperatureSource;
  /** Origen concreto, para el log: `k10temp Tctl` o `/dev/sda`. */
  detail: string;
}

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string }>;

export interface CollectTemperaturesOptions {
  sensors: TemperatureConfig[];
  hwmonRoot?: string;
  smartctlPath?: string;
  sudoPath?: string;
  timeoutMs?: number;
  exec?: ExecFileFn;
}

/** Descarta lecturas imposibles y devuelve un numero redondeado a un decimal. */
export function normalizeReading(celsius: number | null | undefined): number | null {
  if (typeof celsius !== "number" || !Number.isFinite(celsius)) return null;
  if (celsius < MIN_VALID_CELSIUS || celsius > MAX_VALID_CELSIUS) return null;
  return Math.round(celsius * 10) / 10;
}

/**
 * Recolecta las lecturas del inventario en el mismo orden en que estan
 * declaradas. Un sensor que falla no impide leer los demas.
 */
export async function collectTemperatures(
  options: CollectTemperaturesOptions,
): Promise<TemperatureReading[]> {
  const hwmonRoot = options.hwmonRoot ?? DEFAULT_HWMON_ROOT;
  const exec = options.exec ?? defaultExec;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const smartctlPath = options.smartctlPath ?? DEFAULT_SMARTCTL_PATH;
  const sudoPath = options.sudoPath ?? DEFAULT_SUDO_PATH;

  // Los chips solo se leen una vez por ciclo aunque el inventario tenga varios
  // sensores del mismo chip (p. ej. dos sensores de placa).
  const chipDirs = listHwmonChips(hwmonRoot);

  return Promise.all(
    options.sensors.map(async (sensor): Promise<TemperatureReading> => {
      const base = {
        name: sensor.name,
        warn: sensor.warn,
        crit: sensor.crit,
        source: sensor.source,
      };

      if (sensor.source === "hwmon") {
        const detail = `${sensor.chip ?? "?"} ${sensor.label ?? `temp${sensor.index ?? 1}`}`;
        const celsius = readHwmonSensor(chipDirs, sensor);
        return { ...base, celsius: normalizeReading(celsius), detail };
      }

      const device = sensor.device ?? "?";
      const celsius = await readSmartctlTemperature(device, {
        exec,
        smartctlPath,
        sudoPath,
        timeoutMs,
      });
      return { ...base, celsius: normalizeReading(celsius), detail: device };
    }),
  );
}

interface HwmonChip {
  chip: string;
  dir: string;
}

/** Mapea nombre de chip -> directorio de hwmon. */
function listHwmonChips(root: string): HwmonChip[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const chips: HwmonChip[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("hwmon")) continue;
    const dir = join(root, entry);
    try {
      chips.push({ chip: readFileSync(join(dir, "name"), "utf8").trim(), dir });
    } catch {
      // Un hwmon sin `name` no se puede identificar: se ignora.
    }
  }
  return chips;
}

function readHwmonSensor(chips: HwmonChip[], sensor: TemperatureConfig): number | null {
  const chip = chips.find((entry) => entry.chip === sensor.chip);
  if (!chip) return null;

  const index = sensor.label ? findLabelIndex(chip.dir, sensor.label) : (sensor.index ?? 1);
  if (index === null) return null;

  const raw = readNumber(join(chip.dir, `temp${index}_input`));
  // hwmon publica miligrados.
  return raw === null ? null : raw / 1000;
}

function findLabelIndex(dir: string, label: string): number | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const match = /^temp(\d+)_label$/.exec(entry);
    if (!match) continue;
    try {
      if (readFileSync(join(dir, entry), "utf8").trim() === label) {
        return Number(match[1]);
      }
    } catch {
      // Etiqueta ilegible: se prueba con la siguiente.
    }
  }
  return null;
}

function readNumber(path: string): number | null {
  try {
    const value = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

interface SmartctlOptions {
  exec: ExecFileFn;
  smartctlPath: string;
  sudoPath: string;
  timeoutMs: number;
}

async function readSmartctlTemperature(
  device: string,
  options: SmartctlOptions,
): Promise<number | null> {
  const args = ["-j", "-A", "-d", "sat", device];

  const direct = await tryExec(options.exec, options.smartctlPath, args, options.timeoutMs);
  if (direct.temperature !== null) return direct.temperature;

  // Puede faltar permiso de lectura sobre el disco: se reintenta con sudo -n.
  const viaSudo = await tryExec(
    options.exec,
    options.sudoPath,
    ["-n", options.smartctlPath, ...args],
    options.timeoutMs,
  );
  return viaSudo.temperature;
}

/**
 * Ejecuta smartctl y saca la temperatura del JSON. smartctl sale con codigo
 * distinto de cero cuando alguna comprobacion falla aunque el JSON venga
 * completo, asi que se intenta parsear la salida tambien en ese caso.
 */
async function tryExec(
  exec: ExecFileFn,
  file: string,
  args: string[],
  timeout: number,
): Promise<{ temperature: number | null }> {
  let stdout: string;
  try {
    ({ stdout } = await exec(file, args, { timeout }));
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? "";
  }

  if (stdout.trim() === "") return { temperature: null };
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null) return { temperature: null };
    const temperature = (parsed as { temperature?: { current?: unknown } }).temperature;
    const current = temperature?.current;
    return { temperature: typeof current === "number" ? current : null };
  } catch {
    return { temperature: null };
  }
}

const defaultExec: ExecFileFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: options.timeout, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(Object.assign(error, { stdout }));
        return;
      }
      resolve({ stdout });
    });
  });
