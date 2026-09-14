import { describe, expect, it } from "vitest";

import { collectAll } from "../src/collectors/index.ts";

describe.runIf(process.platform === "linux")("collectAll en esta maquina", () => {
  it("reune todas las secciones en una sola pasada", async () => {
    const snapshot = await collectAll({
      diskMount: "/",
      httpTimeoutMs: 2000,
      websites: [],
      serviceGroups: [{ group: "Infra", units: ["nginx", "no-such-unit-xyz"] }],
      temperatureSensors: [
        { source: "hwmon", chip: "k10temp", label: "Tctl", name: "CPU", warn: 75, crit: 90 },
      ],
      bot: () => ({ pingMs: 42, uptimeSeconds: 120 }),
    });

    expect(snapshot.collectedAt).toBeInstanceOf(Date);
    expect(snapshot.system.disk).not.toBeNull();
    expect(snapshot.temperatures).toHaveLength(1);
    expect(snapshot.temperatures[0]?.name).toBe("CPU");
    expect(snapshot.services).toEqual([
      {
        group: "Infra",
        units: [
          { unit: "nginx", state: "active" },
          { unit: "no-such-unit-xyz", state: "unknown" },
        ],
      },
    ]);
    expect(snapshot.websites).toEqual([]);
    expect(snapshot.fail2ban.available).toBe(true);
    expect(snapshot.bot).toEqual({ pingMs: 42, uptimeSeconds: 120 });
  });
});

describe("collectAll", () => {
  it("acepta listas vacias sin tocar la red ni los discos", async () => {
    const snapshot = await collectAll({
      diskMount: "/",
      httpTimeoutMs: 1000,
      websites: [],
      serviceGroups: [],
      temperatureSensors: [],
      fail2ban: {
        exec: async () => {
          throw new Error("fail2ban no disponible en este entorno");
        },
      },
      bot: async () => ({ pingMs: null, uptimeSeconds: 0 }),
    });

    expect(snapshot.services).toEqual([]);
    expect(snapshot.temperatures).toEqual([]);
    expect(snapshot.fail2ban).toMatchObject({ available: false, totalBanned: 0 });
    expect(snapshot.bot.pingMs).toBeNull();
  });
});
