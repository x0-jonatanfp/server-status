import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { collectSystemMetrics, type SystemInformationApi } from "../src/collectors/system.ts";

function fakeApi(overrides: Partial<SystemInformationApi> = {}): SystemInformationApi {
  return {
    currentLoad: async () => ({ currentLoad: 12.5 }),
    mem: async () => ({ total: 1000, available: 200 }),
    fsSize: async () => [{ mount: "/", size: 1000, used: 360 }],
    time: async () => ({ uptime: 3600 }),
    osInfo: async () => ({ hostname: "void", distro: "Ubuntu 24.04", kernel: "7.0.0" }),
    ...overrides,
  };
}

describe("collectSystemMetrics", () => {
  it("calcula el disco como used / size", async () => {
    // size 1000 y used 360 dan 36 %; el campo `use` de systeminformation (que
    // mide used / (used + available)) daria 40 %.
    const metrics = await collectSystemMetrics({ diskMount: "/", api: fakeApi() });
    expect(metrics.disk?.percent).toBeCloseTo(36, 5);
    expect(metrics.disk?.usedBytes).toBe(360);
    expect(metrics.disk?.totalBytes).toBe(1000);
  });

  it("calcula la RAM como total - available", async () => {
    const metrics = await collectSystemMetrics({ diskMount: "/", api: fakeApi() });
    expect(metrics.memory?.usedBytes).toBe(800);
    expect(metrics.memory?.percent).toBeCloseTo(80, 5);
  });

  it("resuelve un punto de montaje anidado y uno colgante", async () => {
    const api = fakeApi({
      fsSize: async () => [
        { mount: "/", size: 1000, used: 100 },
        { mount: "/home", size: 500, used: 250 },
      ],
    });

    const nested = await collectSystemMetrics({ diskMount: "/home", api });
    expect(nested.disk?.mount).toBe("/home");
    expect(nested.disk?.percent).toBeCloseTo(50, 5);

    const child = await collectSystemMetrics({ diskMount: "/home/cultofskaro", api });
    expect(child.disk?.mount).toBe("/home");
  });

  it("devuelve null si el punto de montaje no existe", async () => {
    const api = fakeApi({ fsSize: async () => [{ mount: "/home", size: 500, used: 250 }] });
    const metrics = await collectSystemMetrics({ diskMount: "/srv", api });
    expect(metrics.disk).toBeNull();
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

    const metrics = await collectSystemMetrics({ diskMount: "/", api });
    expect(metrics.memory).toBeNull();
    expect(metrics.os).toBeNull();
    expect(metrics.cpuPercent).toBeCloseTo(12.5, 5);
    expect(metrics.disk?.percent).toBeCloseTo(36, 5);
    expect(metrics.uptimeSeconds).toBe(3600);
  });
});

describe.runIf(process.platform === "linux")("collectSystemMetrics en esta maquina", () => {
  it("el porcentaje de disco coincide con df (used / size) en +-1 %", async () => {
    const mount = "/";
    const metrics = await collectSystemMetrics({ diskMount: mount });

    // `df --output=size,used` da las mismas dos magnitudes que se usan en el
    // calculo. (La columna Uso% de `df -h` divide por used + available, asi que
    // no es comparable con esta metrica.)
    const output = execFileSync("df", ["--output=size,used", "-k", mount], { encoding: "utf8" });
    const row = output.trim().split("\n")[1]?.trim().split(/\s+/) ?? [];
    const sizeKb = Number(row[0]);
    const usedKb = Number(row[1]);

    expect(metrics.disk).not.toBeNull();
    expect(Number.isFinite(sizeKb) && Number.isFinite(usedKb)).toBe(true);

    const expected = (usedKb / sizeKb) * 100;
    expect(Math.abs((metrics.disk?.percent ?? 0) - expected)).toBeLessThanOrEqual(1);
  });

  it("devuelve CPU, RAM, uptime y datos del sistema plausibles", async () => {
    const metrics = await collectSystemMetrics({ diskMount: "/" });

    expect(metrics.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(metrics.cpuPercent).toBeLessThanOrEqual(100);
    expect(metrics.memory?.percent).toBeGreaterThan(0);
    expect(metrics.memory?.percent).toBeLessThanOrEqual(100);
    expect(metrics.memory?.totalBytes).toBeGreaterThan(0);
    expect(metrics.uptimeSeconds).toBeGreaterThan(0);
    expect(metrics.os?.hostname).not.toBe("");
    expect(metrics.os?.kernel).not.toBe("");
  });
});
