import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  collectSystemMetrics,
  createSystemMetricsPort,
  type SystemInformationApi,
} from "../src/infrastructure/metrics/system-information.ts";
import {
  createGpuUsageReader,
  expandPathPattern,
  readGpuBusyPercent,
} from "../src/infrastructure/metrics/gpu-usage.ts";

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "server-status-gpu-"));
  tmpDirs.push(dir);
  return dir;
}

function fakeApi(overrides: Partial<SystemInformationApi> = {}): SystemInformationApi {
  return {
    currentLoad: async () => ({ currentLoad: 12.5 }),
    mem: async () => ({ total: 1000, available: 200 }),
    fsSize: async () => [{ mount: "/", size: 1000, used: 360 }],
    time: async () => ({ uptime: 3600 }),
    osInfo: async () => ({ hostname: "void", distro: "Ubuntu", release: "24.04", kernel: "7.0.0" }),
    ...overrides,
  };
}

/**
 * Lector de GPU de mentira: el sistema no se toca. Respeta el patron nulo, que
 * es como el inventario dice "no midas la GPU".
 */
function fakeGpu(value: number | null) {
  return { read: (pattern: string | null) => (pattern === null ? null : value) };
}

describe("collectSystemMetrics", () => {
  it("calcula el disco como used / size", async () => {
    // size 1000 y used 360 dan 36 %; el campo `use` de systeminformation (que
    // mide used / (used + available)) daria 40 %.
    const metrics = await collectSystemMetrics({ mounts: ["/"], api: fakeApi() });
    const disk = metrics.disks[0];
    expect(disk?.mount).toBe("/");
    expect(disk?.percent).toBeCloseTo(36, 5);
    expect(disk?.usedBytes).toBe(360);
    expect(disk?.totalBytes).toBe(1000);
  });

  it("devuelve un volumen por mount del inventario, aunque vengan desordenados", async () => {
    const api = fakeApi({
      fsSize: async () => [
        { mount: "/", size: 1000, used: 100 },
        { mount: "/mnt/storage", size: 1000, used: 900 },
        { mount: "/mnt/ssd", size: 1000, used: 500 },
      ],
    });

    const metrics = await collectSystemMetrics({
      mounts: ["/", "/mnt/ssd", "/mnt/storage"],
      api,
    });

    expect(metrics.disks.map((disk) => disk.mount).sort()).toEqual([
      "/",
      "/mnt/ssd",
      "/mnt/storage",
    ]);
    expect(metrics.disks.find((disk) => disk.mount === "/mnt/storage")?.percent).toBeCloseTo(90, 5);
  });

  it("no inventa un volumen que el sistema no conoce", async () => {
    const api = fakeApi({ fsSize: async () => [{ mount: "/", size: 1000, used: 100 }] });

    const metrics = await collectSystemMetrics({ mounts: ["/", "/mnt/ssd"], api });

    expect(metrics.disks.map((disk) => disk.mount)).toEqual(["/"]);
  });

  it("calcula la RAM como total - available", async () => {
    const metrics = await collectSystemMetrics({ mounts: ["/"], api: fakeApi() });
    expect(metrics.memory?.usedBytes).toBe(800);
    expect(metrics.memory?.percent).toBeCloseTo(80, 5);
  });

  it("aísla los fallos: una fuente caida no rompe el resto", async () => {
    const api = fakeApi({
      mem: async () => {
        throw new Error("sin memoria");
      },
      osInfo: async () => {
        throw new Error("sin osinfo");
      },
    });

    const metrics = await collectSystemMetrics({ mounts: ["/"], api });
    expect(metrics.memory).toBeNull();
    expect(metrics.os).toBeNull();
    expect(metrics.cpuPercent).toBeCloseTo(12.5, 5);
    expect(metrics.disks[0]?.percent).toBeCloseTo(36, 5);
    expect(metrics.uptimeSeconds).toBe(3600);
  });

  it("deja la GPU en null si no se puede leer, sin inventar un numero", async () => {
    const metrics = await collectSystemMetrics({
      mounts: ["/"],
      gpuBusyPercentPath: "/sys/class/drm/card*/device/gpu_busy_percent",
      api: fakeApi(),
      gpu: fakeGpu(null),
    });

    expect(metrics.gpuPercent).toBeNull();
  });

  it("coge el uso de la GPU cuando el fichero se puede leer", async () => {
    const metrics = await collectSystemMetrics({
      mounts: ["/"],
      gpuBusyPercentPath: "/sys/class/drm/card*/device/gpu_busy_percent",
      api: fakeApi(),
      gpu: fakeGpu(37),
    });

    expect(metrics.gpuPercent).toBe(37);
  });

  it("no mide la GPU si el inventario no declara fichero", async () => {
    const metrics = await collectSystemMetrics({ mounts: ["/"], api: fakeApi(), gpu: fakeGpu(37) });
    expect(metrics.gpuPercent).toBeNull();
  });

  it("implementa el puerto de metricas", async () => {
    const port = createSystemMetricsPort({ mounts: ["/"], api: fakeApi(), gpu: fakeGpu(0) });
    await expect(port.collect()).resolves.toMatchObject({ cpuPercent: 12.5 });
  });
});

describe("readGpuBusyPercent", () => {
  it("expande el `*` del patron y lee el primer fichero legible", () => {
    const root = tmpDir();
    mkdirSync(join(root, "card0"), { recursive: true });
    mkdirSync(join(root, "card1", "device"), { recursive: true });
    mkdirSync(join(root, "card1-HDMI-A-1"), { recursive: true });
    writeFileSync(join(root, "card1", "device", "gpu_busy_percent"), "42\n");

    expect(readGpuBusyPercent(join(root, "card*", "device", "gpu_busy_percent"))).toBe(42);
  });

  it("devuelve null si el fichero no existe, no tiene numero o el patron es null", () => {
    const root = tmpDir();
    mkdirSync(join(root, "card0"), { recursive: true });
    writeFileSync(join(root, "card0", "gpu_busy_percent"), "no-es-un-numero\n");

    expect(readGpuBusyPercent(join(root, "card*", "gpu_busy_percent"))).toBeNull();
    expect(readGpuBusyPercent(join(root, "otra*", "gpu_busy_percent"))).toBeNull();
    expect(readGpuBusyPercent(null)).toBeNull();
  });

  it("acota el porcentaje al rango 0-100", () => {
    const root = tmpDir();
    writeFileSync(join(root, "gpu_busy_percent"), "250\n");
    expect(readGpuBusyPercent(join(root, "gpu_busy_percent"))).toBe(100);
  });

  it("expande solo patrones absolutos", () => {
    expect(expandPathPattern("relative/*/gpu_busy_percent")).toEqual([]);

    const root = tmpDir();
    for (const card of ["card0", "card1"]) {
      mkdirSync(join(root, card, "device"), { recursive: true });
      writeFileSync(join(root, card, "device", "gpu_busy_percent"), "0\n");
    }

    expect(expandPathPattern(join(root, "card*", "device", "gpu_busy_percent"))).toEqual([
      join(root, "card0", "device", "gpu_busy_percent"),
      join(root, "card1", "device", "gpu_busy_percent"),
    ]);
  });

  it("el lector por defecto lee de verdad el fichero de esta maquina", () => {
    const value = createGpuUsageReader().read("/sys/class/drm/card*/device/gpu_busy_percent");
    if (value === null) return; // maquina sin gpu_busy_percent: no es un fallo
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(100);
  });
});

describe.runIf(process.platform === "linux")("collectSystemMetrics en esta maquina", () => {
  it("el porcentaje de disco coincide con df (used / size) en +-1 %", async () => {
    const mount = "/";
    const port = createSystemMetricsPort({ mounts: [mount] });
    const metrics = await port.collect();

    // `df --output=size,used` da las mismas dos magnitudes que se usan en el
    // calculo. (La columna Uso% de `df -h` divide por used + available, asi que
    // no es comparable con esta metrica.)
    const output = execFileSync("df", ["--output=size,used", "-k", mount], { encoding: "utf8" });
    const row = output.trim().split("\n")[1]?.trim().split(/\s+/) ?? [];
    const sizeKb = Number(row[0]);
    const usedKb = Number(row[1]);

    const disk = metrics.disks.find((entry) => entry.mount === mount);
    expect(disk).toBeDefined();
    expect(Number.isFinite(sizeKb) && Number.isFinite(usedKb)).toBe(true);

    const expected = (usedKb / sizeKb) * 100;
    expect(Math.abs((disk?.percent ?? 0) - expected)).toBeLessThanOrEqual(1);
  });

  it("devuelve CPU, RAM, uptime y datos del sistema plausibles", async () => {
    const metrics = await createSystemMetricsPort({ mounts: ["/"] }).collect();

    expect(metrics.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(metrics.cpuPercent).toBeLessThanOrEqual(100);
    expect(metrics.memory?.percent).toBeGreaterThan(0);
    expect(metrics.memory?.percent).toBeLessThanOrEqual(100);
    expect(metrics.memory?.totalBytes).toBeGreaterThan(0);
    expect(metrics.uptimeSeconds).toBeGreaterThan(0);
    expect(metrics.os?.hostname).not.toBe("");
    expect(metrics.os?.kernel).not.toBe("");
    expect(metrics.os?.release).not.toBe("");
  });
});
