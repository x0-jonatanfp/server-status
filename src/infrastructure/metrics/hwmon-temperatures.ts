/**
 * Lectura de temperaturas por `/sys/class/hwmon`.
 *
 * Es la interfaz estable del kernel y no necesita privilegios: cubre CPU, GPU,
 * NVMe y placa base. `systeminformation` no sirve como fuente porque en esta
 * maquina no expone la temperatura de la GPU AMD.
 *
 * El sistema de ficheros va detras de `HwmonFileSystem`, asi que los tests
 * inyectan un doble en lugar de montar un arbol de fixtures.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { TemperatureSensor } from "../../domain/entities/inventory.ts";

export const DEFAULT_HWMON_ROOT = "/sys/class/hwmon";

/** Lo minimo que se necesita del sistema de ficheros. */
export interface HwmonFileSystem {
  listDir(path: string): string[];
  readFile(path: string): string;
}

export const nodeHwmonFileSystem: HwmonFileSystem = {
  listDir: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path, "utf8"),
};

export interface HwmonTemperatureReader {
  /**
   * Lee los sensores indicados y devuelve un valor por sensor, en el mismo
   * orden. `null` si el chip, la etiqueta o el fichero no existen.
   */
  read(sensors: TemperatureSensor[]): Array<number | null>;
}

export interface HwmonTemperatureReaderOptions {
  hwmonRoot?: string;
  fileSystem?: HwmonFileSystem;
}

export function createHwmonTemperatureReader(
  options: HwmonTemperatureReaderOptions = {},
): HwmonTemperatureReader {
  const root = options.hwmonRoot ?? DEFAULT_HWMON_ROOT;
  const fileSystem = options.fileSystem ?? nodeHwmonFileSystem;

  return {
    read(sensors) {
      // Los chips se listan una sola vez por ciclo aunque el inventario tenga
      // varios sensores del mismo chip (p. ej. dos sensores de placa).
      const chips = listHwmonChips(root, fileSystem);
      return sensors.map((sensor) => readSensor(chips, sensor, fileSystem));
    },
  };
}

interface HwmonChip {
  chip: string;
  dir: string;
}

/** Mapea nombre de chip -> directorio de hwmon. */
function listHwmonChips(root: string, fileSystem: HwmonFileSystem): HwmonChip[] {
  let entries: string[];
  try {
    entries = fileSystem.listDir(root);
  } catch {
    return [];
  }

  const chips: HwmonChip[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("hwmon")) continue;
    const dir = join(root, entry);
    try {
      chips.push({ chip: fileSystem.readFile(join(dir, "name")).trim(), dir });
    } catch {
      // Un hwmon sin `name` no se puede identificar: se ignora.
    }
  }
  return chips;
}

/** Devuelve la temperatura en grados, sin filtrar (el rango lo aplica el dominio). */
function readSensor(
  chips: HwmonChip[],
  sensor: TemperatureSensor,
  fileSystem: HwmonFileSystem,
): number | null {
  const chip = chips.find((entry) => entry.chip === sensor.chip);
  if (!chip) return null;

  const index =
    sensor.label === undefined
      ? (sensor.index ?? 1)
      : findLabelIndex(chip.dir, sensor.label, fileSystem);
  if (index === null) return null;

  const raw = readNumber(join(chip.dir, `temp${index}_input`), fileSystem);
  // hwmon publica miligrados.
  return raw === null ? null : raw / 1000;
}

function findLabelIndex(dir: string, label: string, fileSystem: HwmonFileSystem): number | null {
  let entries: string[];
  try {
    entries = fileSystem.listDir(dir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const match = /^temp(\d+)_label$/.exec(entry);
    if (!match?.[1]) continue;
    try {
      if (fileSystem.readFile(join(dir, entry)).trim() === label) return Number(match[1]);
    } catch {
      // Etiqueta ilegible: se prueba con la siguiente.
    }
  }
  return null;
}

function readNumber(path: string, fileSystem: HwmonFileSystem): number | null {
  try {
    const value = Number(fileSystem.readFile(path).trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
