import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { TemperatureConfig } from "../src/config.ts";
import type { ExecFileFn } from "../src/collectors/exec.ts";
import { collectTemperatures, normalizeReading } from "../src/collectors/temperatures.ts";

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/** Escribe un arbol /sys/class/hwmon de mentira para los tests. */
function writeHwmonTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "server-status-hwmon-"));
  tmpDirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `${content}\n`);
  }
  return root;
}

const REAL_HWMON_TREE = {
  // hwmon0: acpitz, sin etiquetas y con un valor que no se usa.
  "hwmon0/name": "acpitz",
  "hwmon0/temp1_input": "16800",
  // hwmon1: NVMe, con etiquetas y varios sensores internos.
  "hwmon1/name": "nvme",
  "hwmon1/temp1_label": "Composite",
  "hwmon1/temp1_input": "40850",
  "hwmon1/temp2_label": "Sensor 1",
  "hwmon1/temp2_input": "41850",
  // hwmon2: placa base, sin etiquetas y con el termistor desconectado a -55 C.
  "hwmon2/name": "it8792",
  "hwmon2/temp1_input": "35000",
  "hwmon2/temp2_input": "-55000",
  "hwmon2/temp3_input": "35000",
  // hwmon3: CPU.
  "hwmon3/name": "k10temp",
  "hwmon3/temp1_label": "Tctl",
  "hwmon3/temp1_input": "47375",
  // hwmon4: GPU.
  "hwmon4/name": "amdgpu",
  "hwmon4/temp1_label": "edge",
  "hwmon4/temp1_input": "44000",
};

const REAL_INVENTORY: TemperatureConfig[] = [
  { source: "hwmon", chip: "k10temp", label: "Tctl", name: "CPU", warn: 75, crit: 90 },
  { source: "hwmon", chip: "amdgpu", label: "edge", name: "GPU", warn: 80, crit: 91 },
  { source: "hwmon", chip: "nvme", label: "Composite", name: "NVMe", warn: 70, crit: 79 },
  { source: "hwmon", chip: "it8792", index: 1, name: "Placa", warn: 60, crit: 80 },
  { source: "hwmon", chip: "it8792", index: 2, name: "Placa rara", warn: 60, crit: 80 },
  { source: "smartctl", device: "/dev/sda", name: "SSD", warn: 60, crit: 70 },
  { source: "smartctl", device: "/dev/sdb", name: "HDD", warn: 55, crit: 65 },
];

/** Exec de mentira: devuelve la temperatura del disco que aparezca en el device. */
function fakeExec(temperatures: Record<string, number | null>): ExecFileFn {
  return async (file, args) => {
    const device = args[args.length - 1] ?? "";
    const current = temperatures[device];
    if (current === undefined) throw new Error(`smartctl no esperado: ${file} ${args.join(" ")}`);
    return { stdout: JSON.stringify({ temperature: { current } }) };
  };
}

describe("collectTemperatures", () => {
  it("devuelve los 7 sensores del inventario en orden", async () => {
    const readings = await collectTemperatures({
      sensors: REAL_INVENTORY,
      hwmonRoot: writeHwmonTree(REAL_HWMON_TREE),
      exec: fakeExec({ "/dev/sda": 38, "/dev/sdb": 34 }),
    });

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
      47.4, // k10temp publica miligrados
      44,
      40.9,
      35,
      null, // -55 C: lectura imposible, descartada
      38,
      34,
    ]);
  });

  it("descarta lecturas fuera del rango 1-120 C", () => {
    expect(normalizeReading(0.5)).toBeNull();
    expect(normalizeReading(-55)).toBeNull();
    expect(normalizeReading(121)).toBeNull();
    expect(normalizeReading(65_261.8)).toBeNull();
    expect(normalizeReading(Number.NaN)).toBeNull();
    expect(normalizeReading(null)).toBeNull();
    expect(normalizeReading(1)).toBe(1);
    expect(normalizeReading(120)).toBe(120);
    expect(normalizeReading(40.85)).toBe(40.9);
  });

  it("devuelve null sin lanzar si smartctl falla", async () => {
    const exec: ExecFileFn = async () => {
      throw new Error("no puedo abrir el disco");
    };
    const readings = await collectTemperatures({
      sensors: [{ source: "smartctl", device: "/dev/sda", name: "SSD", warn: 60, crit: 70 }],
      hwmonRoot: writeHwmonTree(REAL_HWMON_TREE),
      exec,
    });
    expect(readings).toHaveLength(1);
    expect(readings[0]?.celsius).toBeNull();
  });

  it("devuelve null sin lanzar si smartctl responde basura", async () => {
    const exec: ExecFileFn = async () => ({ stdout: "esto no es json" });
    const readings = await collectTemperatures({
      sensors: [{ source: "smartctl", device: "/dev/sda", name: "SSD", warn: 60, crit: 70 }],
      hwmonRoot: writeHwmonTree(REAL_HWMON_TREE),
      exec,
    });
    expect(readings[0]?.celsius).toBeNull();
  });

  it("reintenta con sudo -n cuando smartctl no puede leer el disco", async () => {
    const calls: string[][] = [];
    const exec: ExecFileFn = async (file, args) => {
      calls.push([file, ...args]);
      if (file.includes("sudo")) {
        return { stdout: JSON.stringify({ temperature: { current: 39 } }) };
      }
      throw new Error("permiso denegado");
    };

    const readings = await collectTemperatures({
      sensors: [{ source: "smartctl", device: "/dev/sda", name: "SSD", warn: 60, crit: 70 }],
      hwmonRoot: writeHwmonTree(REAL_HWMON_TREE),
      exec,
      sudoPath: "/usr/bin/sudo",
      smartctlPath: "/usr/sbin/smartctl",
    });

    expect(readings[0]?.celsius).toBe(39);
    expect(calls).toEqual([
      ["/usr/sbin/smartctl", "-j", "-A", "-d", "sat", "/dev/sda"],
      ["/usr/bin/sudo", "-n", "/usr/sbin/smartctl", "-j", "-A", "-d", "sat", "/dev/sda"],
    ]);
  });

  it("devuelve null si no hay /sys/class/hwmon o el sensor no existe", async () => {
    const readings = await collectTemperatures({
      sensors: [
        { source: "hwmon", chip: "k10temp", label: "Tctl", name: "CPU", warn: 75, crit: 90 },
        { source: "hwmon", chip: "inexistente", name: "Fantasma", warn: 50, crit: 60 },
      ],
      hwmonRoot: join(tmpdir(), "server-status-hwmon-inexistente"),
    });

    expect(readings.map((reading) => reading.celsius)).toEqual([null, null]);
    expect(readings[0]?.detail).toBe("k10temp Tctl");
  });

});

describe.runIf(process.platform === "linux")("en esta maquina (hwmon real)", () => {
  const realSensors: TemperatureConfig[] = [
    { source: "hwmon", chip: "k10temp", label: "Tctl", name: "CPU", warn: 75, crit: 90 },
    { source: "hwmon", chip: "amdgpu", label: "edge", name: "GPU", warn: 80, crit: 91 },
    // Solo el Composite del NVMe: los sensores internos no se muestran.
    { source: "hwmon", chip: "nvme", label: "Composite", name: "NVMe", warn: 70, crit: 79 },
    { source: "hwmon", chip: "it8792", index: 1, name: "Placa", warn: 60, crit: 80 },
    { source: "hwmon", chip: "it8792", index: 3, name: "Placa 2", warn: 60, crit: 80 },
  ];

  it("encuentra los sensores de CPU, GPU, NVMe y placa", async () => {
    const readings = await collectTemperatures({ sensors: realSensors, exec: fakeExec({}) });

    // Las lecturas cambian entre ejecuciones: lo que se comprueba es que las
    // etiquetas del inventario resuelven a un sensor y dan un valor valido.
    for (const reading of readings) {
      expect(reading.celsius, `${reading.name} (${reading.detail})`).not.toBeNull();
      expect(reading.celsius).toBeGreaterThanOrEqual(1);
      expect(reading.celsius).toBeLessThanOrEqual(120);
    }
  });

  it("no devuelve ninguna lectura fuera del rango, ni con los discos SATA", async () => {
    const readings = await collectTemperatures({
      sensors: [
        ...realSensors,
        { source: "smartctl", device: "/dev/sda", name: "SSD", warn: 60, crit: 70 },
        { source: "smartctl", device: "/dev/sdb", name: "HDD", warn: 55, crit: 65 },
      ],
    });

    const hwmon = readings.filter((reading) => reading.source === "hwmon");
    expect(hwmon.map((reading) => reading.celsius)).not.toContain(null);
    for (const reading of readings) {
      if (reading.celsius === null) continue;
      expect(reading.celsius).toBeGreaterThanOrEqual(1);
      expect(reading.celsius).toBeLessThanOrEqual(120);
    }
  });
});
