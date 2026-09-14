import { describe, expect, it } from "vitest";

import { AlertManager } from "../src/alerts/alertManager.ts";
import type { StatusSnapshot } from "../src/collectors/index.ts";

const THRESHOLDS = {
  cpu_percent: { warn: 70, crit: 90 },
  memory_percent: { warn: 70, crit: 90 },
  disk_percent: { warn: 80, crit: 95 },
  ping_ms: { warn: 100, crit: 500 },
};

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    collectedAt: new Date(2026, 8, 14, 14, 32, 10),
    system: {
      cpuPercent: 10,
      memory: { percent: 20, usedBytes: 0, totalBytes: 0 },
      disk: { mount: "/", percent: 30, usedBytes: 0, totalBytes: 0 },
      uptimeSeconds: 3600,
      os: null,
    },
    temperatures: [],
    services: [],
    websites: [],
    fail2ban: { available: true, totalBanned: 0, jails: [], error: null },
    bot: { pingMs: 42, uptimeSeconds: 3600 },
    ...overrides,
  };
}

function temperature(celsius: number, warn = 75, crit = 90) {
  return { source: "hwmon" as const, name: "CPU", celsius, warn, crit, detail: "k10temp Tctl" };
}

describe("AlertManager", () => {
  it("dispara una alerta de temperatura y no la repite dentro del cooldown", () => {
    let now = 1_000_000;
    const alerts = new AlertManager({ cooldownMinutes: 30, thresholds: THRESHOLDS, now: () => now });
    const hot = snapshot({ temperatures: [temperature(95)] });

    const first = alerts.evaluate(hot);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ key: "temperature:CPU", severity: "critical" });
    expect(first[0]?.detail).toContain("95.0 °C");

    // Diez minutos despues sigue dentro del cooldown.
    now += 10 * 60_000;
    expect(alerts.evaluate(hot)).toEqual([]);

    // A los 31 minutos vuelve a avisar.
    now += 21 * 60_000;
    expect(alerts.evaluate(hot)).toHaveLength(1);
  });

  it("avisa al momento si la gravedad sube, aunque el cooldown siga vivo", () => {
    let now = 1_000_000;
    const alerts = new AlertManager({ cooldownMinutes: 30, thresholds: THRESHOLDS, now: () => now });

    const warning = alerts.evaluate(snapshot({ temperatures: [temperature(80)] }));
    expect(warning[0]?.severity).toBe("warning");

    now += 60_000;
    const critical = alerts.evaluate(snapshot({ temperatures: [temperature(95)] }));
    expect(critical).toHaveLength(1);
    expect(critical[0]?.severity).toBe("critical");

    // Pero el aviso de 80 C no se repite.
    expect(alerts.evaluate(snapshot({ temperatures: [temperature(80)] }))).toEqual([]);
  });

  it("usa los umbrales de cada sensor, no uno global", () => {
    const alerts = new AlertManager({ cooldownMinutes: 0, thresholds: THRESHOLDS });

    // 80 C es critico para un NVMe con crit 79, pero solo aviso para una GPU
    // con warn 80 y crit 91.
    const nvme = alerts.evaluate(
      snapshot({
        temperatures: [
          { source: "hwmon", name: "NVMe", celsius: 80, warn: 70, crit: 79, detail: "nvme" },
        ],
      }),
    );
    expect(nvme[0]?.severity).toBe("critical");

    const gpu = alerts.evaluate(
      snapshot({
        temperatures: [
          { source: "hwmon", name: "GPU", celsius: 80, warn: 80, crit: 91, detail: "amdgpu" },
        ],
      }),
    );
    expect(gpu[0]?.severity).toBe("warning");
  });

  it("alerta de CPU, RAM, disco y latencia del bot", () => {
    const alerts = new AlertManager({ cooldownMinutes: 30, thresholds: THRESHOLDS });

    const emitted = alerts.evaluate(
      snapshot({
        system: {
          cpuPercent: 91,
          memory: { percent: 75, usedBytes: 0, totalBytes: 0 },
          disk: { mount: "/", percent: 96, usedBytes: 0, totalBytes: 0 },
          uptimeSeconds: 3600,
          os: null,
        },
        bot: { pingMs: 620, uptimeSeconds: 3600 },
      }),
    );

    expect(emitted.map((alert) => alert.key)).toEqual([
      "metric:cpu_percent",
      "metric:memory_percent",
      "metric:disk_percent",
      "metric:ping_ms",
    ]);
    expect(emitted.map((alert) => alert.severity)).toEqual([
      "critical",
      "warning",
      "critical",
      "critical",
    ]);
  });

  it("no alerta de lo que no se puede medir ni de lo que esta bien", () => {
    const alerts = new AlertManager({ cooldownMinutes: 30, thresholds: THRESHOLDS });

    const emitted = alerts.evaluate(
      snapshot({
        system: { cpuPercent: null, memory: null, disk: null, uptimeSeconds: null, os: null },
        temperatures: [
          { source: "smartctl", name: "SSD", celsius: null, warn: 60, crit: 70, detail: "/dev/sda" },
          { source: "hwmon", name: "GPU", celsius: 44, warn: 80, crit: 91, detail: "amdgpu" },
        ],
        bot: { pingMs: null, uptimeSeconds: 0 },
      }),
    );

    expect(emitted).toEqual([]);
  });

  it("con cooldown 0 avisa en cada evaluacion", () => {
    const alerts = new AlertManager({ cooldownMinutes: 0, thresholds: THRESHOLDS });
    const hot = snapshot({ temperatures: [temperature(95)] });

    expect(alerts.evaluate(hot)).toHaveLength(1);
    expect(alerts.evaluate(hot)).toHaveLength(1);
  });

  it("respeta el umbral de aviso exacto", () => {
    const alerts = new AlertManager({ cooldownMinutes: 0, thresholds: THRESHOLDS });

    expect(alerts.evaluate(snapshot({ system: { ...snapshot().system, cpuPercent: 69.9 } }))).toEqual([]);
    expect(alerts.evaluate(snapshot({ system: { ...snapshot().system, cpuPercent: 70 } }))).toHaveLength(1);
  });
});
