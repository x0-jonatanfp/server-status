/**
 * Temperaturas: los sensores van detras de puertos, asi que aqui no hay ni un
 * fichero de `/sys/class/hwmon` ni un `smartctl` de verdad. Se le pasan dobles
 * al lector de hwmon (su sistema de ficheros es inyectable) y al de smartctl
 * (`exec` inyectable), y al adaptador del puerto se le dan lectores ya hechos.
 *
 * Es justo el motivo de la hexagonal: el test comprueba el filtrado, el orden y
 * los fallos sin depender de los sensores de la maquina.
 */
import { describe, expect, it } from "vitest";

import type { TemperatureSensor } from "../src/domain/entities/inventory.ts";
import type { TemperatureReading } from "../src/domain/entities/temperature-reading.ts";
import { MAX_VALID_CELSIUS, MIN_VALID_CELSIUS, normalizeReading } from "../src/domain/services/temperatures.ts";
import type { ExecFileFn } from "../src/infrastructure/exec.ts";
import {
  createHwmonTemperatureReader,
  DEFAULT_HWMON_ROOT,
  type HwmonFileSystem,
} from "../src/infrastructure/metrics/hwmon-temperatures.ts";
import { createSmartctlTemperatureReader } from "../src/infrastructure/metrics/smartctl-temperatures.ts";
import {
  createTemperaturePort,
  describeSensor,
} from "../src/infrastructure/metrics/temperatures.ts";

/** Arbol de hwmon en memoria: `{ chip: { fichero: contenido } }`. */
function memoryHwmon(tree: Record<string, Record<string, string>>, root = "/fake/hwmon") {
  const fileSystem: HwmonFileSystem = {
    listDir(path) {
      if (path === root) return Object.keys(tree);
      const chip = path.slice(root.length + 1);
      const dir = tree[chip];
      if (!dir) throw new Error(`no existe ${path}`);
      return Object.keys(dir);
    },
    readFile(path) {
      const [chip, ...rest] = path.slice(root.length + 1).split("/");
      const content = chip === undefined ? undefined : tree[chip]?.[rest.join("/")];
      if (content === undefined) throw new Error(`no existe ${path}`);
      return content;
    },
  };
  return { root, fileSystem };
}

/** El mismo reparto de chips de la maquina, pero en memoria. */
const HWMON_TREE = {
  hwmon0: { name: "acpitz", temp1_input: "16800" },
  hwmon1: {
    name: "nvme",
    temp1_label: "Composite",
    temp1_input: "40850",
    temp2_label: "Sensor 1",
    temp2_input: "41850",
  },
  hwmon2: {
    name: "it8792",
    temp1_input: "35000",
    // Termistor desconectado: lectura imposible, la descarta el dominio.
    temp2_input: "-55000",
    temp3_input: "35000",
  },
  hwmon3: { name: "k10temp", temp1_label: "Tctl", temp1_input: "47375" },
  hwmon4: { name: "amdgpu", temp1_label: "edge", temp1_input: "44000" },
};

const SENSORS: TemperatureSensor[] = [
  { source: "hwmon", chip: "k10temp", label: "Tctl", name: "CPU", warn: 75, crit: 90 },
  { source: "hwmon", chip: "amdgpu", label: "edge", name: "GPU", warn: 80, crit: 91 },
  { source: "hwmon", chip: "nvme", label: "Composite", name: "NVMe", warn: 70, crit: 79 },
  { source: "hwmon", chip: "it8792", index: 1, name: "Placa", warn: 60, crit: 80 },
  { source: "hwmon", chip: "it8792", index: 2, name: "Placa rara", warn: 60, crit: 80 },
  { source: "smartctl", device: "/dev/sda", name: "SSD", warn: 60, crit: 70 },
  { source: "smartctl", device: "/dev/sdb", name: "HDD", warn: 55, crit: 65 },
];

/** Lector de hwmon de mentira: una lectura por sensor, en su orden. */
function fakeHwmonReader(readings: Array<number | null>) {
  const seen: string[] = [];
  return {
    reader: {
      read(sensors: TemperatureSensor[]): Array<number | null> {
        seen.push(...sensors.map((sensor) => sensor.name));
        return readings;
      },
    },
    seen,
  };
}

function fakeSmartctlReader(readings: Record<string, number | null>) {
  const seen: string[] = [];
  return {
    reader: {
      async read(sensor: TemperatureSensor): Promise<number | null> {
        const device = sensor.device ?? "?";
        seen.push(device);
        return readings[device] ?? null;
      },
    },
    seen,
  };
}

describe("adaptador del puerto de temperaturas", () => {
  it("devuelve los 7 sensores del inventario en orden y filtra los imposibles", async () => {
    const hwmon = fakeHwmonReader([47.375, 44, 40.85, 35, -55]);
    const smartctl = fakeSmartctlReader({ "/dev/sda": 38, "/dev/sdb": 34 });

    const port = createTemperaturePort({
      sensors: SENSORS,
      hwmon: hwmon.reader,
      smartctl: smartctl.reader,
    });
    const readings = await port.collect();

    expect(readings.map((reading) => reading.name)).toEqual([
      "CPU",
      "GPU",
      "NVMe",
      "Placa",
      "Placa rara",
      "SSD",
      "HDD",
    ]);
    expect(readings.map((reading) => reading.celsius)).toEqual([
      // hwmon publica miligrados y el dominio redondea a un decimal: 47375 -> 47.4
      47.4,
      44,
      40.9, // 40850 -> 40.85 -> 40.9
      35,
      null, // -55 C: lectura imposible, descartada
      38,
      34,
    ]);
    // Solo se le piden a hwmon los sensores de hwmon, y a smartctl los discos.
    expect(hwmon.seen).toEqual(["CPU", "GPU", "NVMe", "Placa", "Placa rara"]);
    expect(smartctl.seen).toEqual(["/dev/sda", "/dev/sdb"]);
  });

  it("cada sensor lleva sus umbrales, no unos globales", async () => {
    const port = createTemperaturePort({
      sensors: SENSORS,
      hwmon: fakeHwmonReader([47.375, 44, 40.85, 35, null]).reader,
      smartctl: fakeSmartctlReader({}).reader,
    });
    const readings = await port.collect();

    expect(readings[0]).toMatchObject({ name: "CPU", warn: 75, crit: 90 });
    expect(readings[5]).toMatchObject({ name: "SSD", warn: 60, crit: 70, source: "smartctl" });
  });

  it("un sensor que el lector no sabe resolver sale N/A sin romper el resto", async () => {
    const port = createTemperaturePort({
      sensors: SENSORS,
      hwmon: fakeHwmonReader([null, 44, null, null, null]).reader,
      smartctl: fakeSmartctlReader({ "/dev/sdb": 34 }).reader,
    });
    const readings = await port.collect();

    expect(readings.map((reading) => reading.celsius)).toEqual([null, 44, null, null, null, null, 34]);
  });
});

describe("normalizeReading (regla del dominio)", () => {
  it("descarta lecturas fuera del rango 1-120 C", () => {
    expect(normalizeReading(0.5)).toBeNull();
    expect(normalizeReading(-55)).toBeNull();
    expect(normalizeReading(121)).toBeNull();
    expect(normalizeReading(65_261.8)).toBeNull();
    expect(normalizeReading(Number.NaN)).toBeNull();
    expect(normalizeReading(null)).toBeNull();
    expect(normalizeReading(MIN_VALID_CELSIUS)).toBe(1);
    expect(normalizeReading(MAX_VALID_CELSIUS)).toBe(120);
    expect(normalizeReading(40.85)).toBe(40.9);
  });
});

describe("lector de hwmon", () => {
  it("resuelve por etiqueta, por indice y con el chip ausente", () => {
    const { root, fileSystem } = memoryHwmon(HWMON_TREE);
    const reader = createHwmonTemperatureReader({ hwmonRoot: root, fileSystem });

    const values = reader.read([
      { source: "hwmon", chip: "k10temp", label: "Tctl", name: "CPU", warn: 75, crit: 90 },
      { source: "hwmon", chip: "nvme", label: "Composite", name: "NVMe", warn: 70, crit: 79 },
      { source: "hwmon", chip: "it8792", index: 1, name: "Placa", warn: 60, crit: 80 },
      { source: "hwmon", chip: "inexistente", name: "Fantasma", warn: 50, crit: 60 },
    ]);

    // hwmon publica miligrados y el filtro es del dominio, aqui no se aplica.
    expect(values).toEqual([47.375, 40.85, 35, null]);
  });

  it("devuelve null si no hay ningun chip que coincida con la etiqueta", () => {
    const { root, fileSystem } = memoryHwmon(HWMON_TREE);
    const reader = createHwmonTemperatureReader({ hwmonRoot: root, fileSystem });

    expect(
      reader.read([
        { source: "hwmon", chip: "nvme", label: "Sensor 5", name: "NVMe", warn: 70, crit: 79 },
      ]),
    ).toEqual([null]);
  });

  it("no lanza si el arbol de hwmon no existe", () => {
    const reader = createHwmonTemperatureReader({
      hwmonRoot: "/no/existe",
      fileSystem: {
        listDir() {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
        readFile() {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      },
    });

    expect(
      reader.read([{ source: "hwmon", chip: "k10temp", label: "Tctl", name: "CPU", warn: 75, crit: 90 }]),
    ).toEqual([null]);
  });

  it("por defecto lee el hwmon real del kernel", () => {
    expect(DEFAULT_HWMON_ROOT).toBe("/sys/class/hwmon");
  });
});

describe("lector de smartctl", () => {
  function sensor(device = "/dev/sda"): TemperatureSensor {
    return { source: "smartctl", device, name: "SSD", warn: 60, crit: 70 };
  }

  it("saca la temperatura del JSON", async () => {
    const exec: ExecFileFn = async () => ({
      stdout: JSON.stringify({ temperature: { current: 38 } }),
    });
    const reader = createSmartctlTemperatureReader({ exec });

    await expect(reader.read(sensor())).resolves.toBe(38);
  });

  it("la saca tambien cuando smartctl sale con codigo distinto de cero", async () => {
    const exec: ExecFileFn = async () => {
      // smartctl devuelve el JSON completo y aun asi falla la comprobacion.
      throw Object.assign(new Error("salida 4"), {
        stdout: JSON.stringify({ temperature: { current: 39 } }),
      });
    };

    await expect(createSmartctlTemperatureReader({ exec }).read(sensor())).resolves.toBe(39);
  });

  it("reintenta con sudo -n cuando el primer intento no puede abrir el disco", async () => {
    const calls: string[][] = [];
    const exec: ExecFileFn = async (file, args) => {
      calls.push([file, ...args]);
      if (file.includes("sudo")) {
        return { stdout: JSON.stringify({ temperature: { current: 39 } }) };
      }
      throw new Error("permiso denegado");
    };

    const reader = createSmartctlTemperatureReader({
      exec,
      sudoPath: "/usr/bin/sudo",
      smartctlPath: "/usr/sbin/smartctl",
    });

    await expect(reader.read(sensor())).resolves.toBe(39);
    expect(calls).toEqual([
      ["/usr/sbin/smartctl", "-j", "-A", "-d", "sat", "/dev/sda"],
      ["/usr/bin/sudo", "-n", "/usr/sbin/smartctl", "-j", "-A", "-d", "sat", "/dev/sda"],
    ]);
  });

  it("devuelve null sin lanzar si smartctl falla o responde basura", async () => {
    const failing = createSmartctlTemperatureReader({
      exec: async () => {
        throw new Error("no puedo abrir el disco");
      },
    });
    await expect(failing.read(sensor())).resolves.toBeNull();

    const garbage = createSmartctlTemperatureReader({
      exec: async () => ({ stdout: "esto no es json" }),
    });
    await expect(garbage.read(sensor())).resolves.toBeNull();
  });

  it("no consulta nada si el sensor no tiene dispositivo", async () => {
    let called = false;
    const reader = createSmartctlTemperatureReader({
      exec: async () => {
        called = true;
        return { stdout: "" };
      },
    });

    await expect(reader.read({ source: "smartctl", name: "SSD", warn: 60, crit: 70 })).resolves.toBeNull();
    expect(called).toBe(false);
  });
});

describe("describeSensor", () => {
  it("nombra el origen concreto de cada sensor", () => {
    const readings: Array<[TemperatureSensor, string]> = [
      [{ source: "hwmon", chip: "k10temp", label: "Tctl", name: "CPU", warn: 75, crit: 90 }, "k10temp Tctl"],
      [{ source: "hwmon", chip: "it8792", index: 3, name: "Placa", warn: 60, crit: 80 }, "it8792 temp3"],
      [{ source: "smartctl", device: "/dev/sda", name: "SSD", warn: 60, crit: 70 }, "/dev/sda"],
    ];

    for (const [sensor, expected] of readings) {
      expect(describeSensor(sensor)).toBe(expected);
    }
  });
});

/** Comprobacion con los sensores reales de esta maquina, sin tocar el sistema. */
describe.runIf(process.platform === "linux")("adaptador con los sensores de esta maquina", () => {
  it("todas las lecturas validas caen dentro del rango fisico", async () => {
    const { root, fileSystem } = memoryHwmon(HWMON_TREE);
    const port = createTemperaturePort({
      sensors: SENSORS,
      hwmon: createHwmonTemperatureReader({ hwmonRoot: root, fileSystem }),
      smartctl: fakeSmartctlReader({ "/dev/sda": 38, "/dev/sdb": 34 }).reader,
    });

    const readings: TemperatureReading[] = await port.collect();
    for (const reading of readings) {
      if (reading.celsius === null) continue;
      expect(reading.celsius).toBeGreaterThanOrEqual(MIN_VALID_CELSIUS);
      expect(reading.celsius).toBeLessThanOrEqual(MAX_VALID_CELSIUS);
    }
  });
});
