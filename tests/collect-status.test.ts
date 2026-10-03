import { describe, expect, it } from "vitest";

import { collectStatus, type CollectStatusPorts } from "../src/application/collect-status.ts";
import type { Fail2banPort } from "../src/domain/ports/fail2ban.ts";
import type { MetricsPort } from "../src/domain/ports/metrics.ts";
import type { ServiceStatusPort } from "../src/domain/ports/services.ts";
import type { TemperaturePort } from "../src/domain/ports/temperatures.ts";
import type { WebsiteProbePort } from "../src/domain/ports/websites.ts";
import { createSystemMetricsPort } from "../src/infrastructure/metrics/system-information.ts";
import { createTemperaturePort } from "../src/infrastructure/metrics/temperatures.ts";
import { createServiceStatusPort } from "../src/infrastructure/systemd/service-status.ts";

/** Un snapshot de mentira por cada puerto: nada del sistema entra aqui. */
function fakePorts(): CollectStatusPorts {
  const metrics: MetricsPort = {
    collect: async () => ({
      cpuPercent: 12.4,
      gpuPercent: 0,
      memory: null,
      disks: [],
      uptimeSeconds: 3600,
      os: null,
    }),
  };
  const temperatures: TemperaturePort = {
    collect: async () => [
      { source: "hwmon", name: "CPU", celsius: 53.6, warn: 75, crit: 90, detail: "k10temp Tctl" },
    ],
  };
  const services: ServiceStatusPort = {
    collect: async () => [{ group: "Infra", units: [{ unit: "nginx", state: "active" }] }],
  };
  const websites: WebsiteProbePort = {
    probe: async () => [
      { label: "example.com", url: "https://example.com", up: true, statusCode: 200, latencyMs: 10, error: null },
    ],
  };
  const fail2ban: Fail2banPort = {
    status: async () => ({
      available: true,
      totalBanned: 13,
      jails: [{ name: "dummy", banned: 7 }],
      error: null,
    }),
    unban: async (ip) => ({ ip, jails: [] }),
  };
  const botStatus = { status: () => ({ pingMs: 42, uptimeSeconds: 120 }) };

  return { metrics, temperatures, services, websites, fail2ban, botStatus };
}

describe("collectStatus", () => {
  it("reune las seis fuentes en un solo snapshot", async () => {
    const snapshot = await collectStatus(fakePorts());

    expect(snapshot.collectedAt).toBeInstanceOf(Date);
    expect(snapshot.system.cpuPercent).toBe(12.4);
    expect(snapshot.temperatures).toHaveLength(1);
    expect(snapshot.services).toEqual([
      { group: "Infra", units: [{ unit: "nginx", state: "active" }] },
    ]);
    expect(snapshot.websites[0]).toMatchObject({ label: "example.com", up: true });
    expect(snapshot.fail2ban.totalBanned).toBe(13);
    expect(snapshot.bot).toEqual({ pingMs: 42, uptimeSeconds: 120 });
  });

  it("consulta los puertos en paralelo, no en serie", async () => {
    const order: string[] = [];
    async function measure(name: string): Promise<void> {
      order.push(`${name}:entra`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`${name}:sale`);
    }

    const ports = fakePorts();
    ports.metrics.collect = async () => {
      await measure("metrics");
      return {
        cpuPercent: null,
        gpuPercent: null,
        memory: null,
        disks: [],
        uptimeSeconds: null,
        os: null,
      };
    };
    ports.temperatures.collect = async () => {
      await measure("temperatures");
      return [];
    };
    ports.websites.probe = async () => {
      await measure("websites");
      return [];
    };
    ports.fail2ban.status = async () => {
      await measure("fail2ban");
      return { available: false, totalBanned: 0, jails: [], error: "sin datos" };
    };

    await collectStatus(ports);

    // Los cuatro entran antes de que el primero salga: van en paralelo.
    expect(order.slice(0, 4).sort()).toEqual([
      "fail2ban:entra",
      "metrics:entra",
      "temperatures:entra",
      "websites:entra",
    ]);
  });
});

/** Integracion: los adaptadores reales detras de los puertos, en esta maquina. */
describe.runIf(process.platform === "linux")("collectStatus con los adaptadores reales", () => {
  it("una unidad inexistente se reporta unknown y no rompe el snapshot", async () => {
    const snapshot = await collectStatus({
      metrics: createSystemMetricsPort({ mounts: ["/"] }),
      temperatures: createTemperaturePort({
        sensors: [
          { source: "hwmon", chip: "k10temp", label: "Tctl", name: "CPU", warn: 75, crit: 90 },
        ],
      }),
      services: createServiceStatusPort({
        groups: [{ group: "Infra", units: ["nginx", "no-such-unit-xyz"] }],
      }),
      websites: { probe: async () => [] },
      fail2ban: {
        status: async () => ({ available: false, totalBanned: 0, jails: [], error: "no usado" }),
        unban: async (ip) => ({ ip, jails: [] }),
      },
      botStatus: { status: () => ({ pingMs: 42, uptimeSeconds: 120 }) },
    });

    expect(snapshot.system.disks.map((disk) => disk.mount)).toContain("/");
    expect(snapshot.services).toEqual([
      {
        group: "Infra",
        units: [
          { unit: "nginx", state: "active" },
          { unit: "no-such-unit-xyz", state: "unknown" },
        ],
      },
    ]);
    expect(snapshot.temperatures[0]?.celsius).not.toBeNull();
  });
});
