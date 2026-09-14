import { MessageFlags } from "discord.js";
import { expect, describe, it } from "vitest";

import type {
  DisplayConfig,
  MetricKey,
  MetricThreshold,
} from "../src/config.ts";
import type { StatusSnapshot } from "../src/collectors/index.ts";
import {
  countComponents,
  renderStatusView,
  toComponents,
  type StatusViewOptions,
} from "../src/render/statusView.ts";

const DISPLAY: DisplayConfig = {
  showGroups: true,
  showFail2banBreakdown: true,
  showPing: true,
  progressBarBlocks: 5,
  colors: { ok: "#00FF41", warning: "#FFAA00", critical: "#FF0040" },
};

const THRESHOLDS: Record<MetricKey, MetricThreshold> = {
  cpu_percent: { warn: 70, crit: 90 },
  memory_percent: { warn: 70, crit: 90 },
  disk_percent: { warn: 80, crit: 95 },
  ping_ms: { warn: 100, crit: 500 },
};

function options(overrides: Partial<StatusViewOptions> = {}): StatusViewOptions {
  return {
    display: DISPLAY,
    thresholds: THRESHOLDS,
    hostLabel: "example.com",
    updateIntervalSeconds: 300,
    version: "1.0.0",
    ...overrides,
  };
}

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    collectedAt: new Date(2026, 8, 14, 14, 32, 10),
    system: {
      cpuPercent: 12.4,
      memory: { percent: 18.4, usedBytes: 5.8 * 1024 ** 3, totalBytes: 31.3 * 1024 ** 3 },
      disk: {
        mount: "/",
        percent: 36,
        usedBytes: 164.5 * 1024 ** 3,
        totalBytes: 456.9 * 1024 ** 3,
      },
      uptimeSeconds: 4 * 86_400 + 12 * 3600 + 7 * 60,
      os: { hostname: "void", distro: "Ubuntu 24.04", kernel: "7.0.0" },
    },
    temperatures: [
      { source: "hwmon", name: "CPU", celsius: 53.6, warn: 75, crit: 90, detail: "k10temp Tctl" },
      { source: "hwmon", name: "GPU", celsius: 44, warn: 80, crit: 91, detail: "amdgpu edge" },
      { source: "hwmon", name: "NVMe", celsius: 40.9, warn: 70, crit: 79, detail: "nvme Composite" },
      { source: "hwmon", name: "Placa", celsius: 35, warn: 60, crit: 80, detail: "it8792 temp1" },
      { source: "smartctl", name: "SSD", celsius: 38, warn: 60, crit: 70, detail: "/dev/sda" },
      { source: "smartctl", name: "HDD", celsius: 34, warn: 55, crit: 65, detail: "/dev/sdb" },
    ],
    services: [
      {
        group: "Infra",
        units: [
          { unit: "nginx", state: "active" },
          { unit: "fail2ban", state: "active" },
          { unit: "postgresql@16-main", state: "active" },
        ],
      },
      {
        group: "Apps",
        units: [
          { unit: "example", state: "active" },
          { unit: "app-pixel", state: "active" },
        ],
      },
      { group: "Bots", units: [{ unit: "void-agent", state: "active" }] },
    ],
    websites: [
      { label: "example.com", url: "https://example.com", up: true, statusCode: 200, latencyMs: 118, error: null },
      { label: "www.example.com", url: "https://www.example.com", up: true, statusCode: 200, latencyMs: 105, error: null },
      { label: "example.org", url: "https://example.org", up: true, statusCode: 200, latencyMs: 131, error: null },
    ],
    fail2ban: {
      available: true,
      totalBanned: 37,
      jails: [
        { name: "dovecot", banned: 0 },
        { name: "recidive", banned: 31 },
        { name: "sshd", banned: 6 },
      ],
      error: null,
    },
    bot: { pingMs: 42, uptimeSeconds: 3600 },
    ...overrides,
  };
}

describe("renderStatusView", () => {
  it("compone el mensaje completo", () => {
    expect(renderStatusView(snapshot(), options()).blocks).toMatchSnapshot();
  });

  it("el color de acento sigue el estado global", () => {
    const ok = renderStatusView(snapshot(), options());
    expect(ok.level).toBe("ok");
    expect(ok.accentColor).toBe(0x00ff41);

    const warning = renderStatusView(
      snapshot({
        temperatures: [
          { source: "hwmon", name: "GPU", celsius: 84, warn: 80, crit: 91, detail: "amdgpu edge" },
        ],
      }),
      options(),
    );
    expect(warning.level).toBe("warning");
    expect(warning.accentColor).toBe(0xffaa00);

    const critical = renderStatusView(
      snapshot({
        services: [{ group: "Infra", units: [{ unit: "nginx", state: "failed" }] }],
      }),
      options(),
    );
    expect(critical.level).toBe("critical");
    expect(critical.accentColor).toBe(0xff0040);
  });

  it("marca un servicio caido y cuenta los activos", () => {
    const view = renderStatusView(
      snapshot({
        services: [
          {
            group: "Infra",
            units: [
              { unit: "nginx", state: "active" },
              { unit: "fail2ban", state: "failed" },
              { unit: "redis-server", state: "inactive" },
              { unit: "fantasma", state: "unknown" },
            ],
          },
        ],
      }),
      options(),
    );

    const services = view.blocks.find((block) => block.startsWith("🧩"));
    expect(services).toContain("1/4 activos");
    expect(services).toContain("❌ fail2ban");
    expect(services).toContain("⚠️ redis-server");
    expect(services).toContain("❔ fantasma");
  });

  it("una web caida muestra el codigo o el motivo", () => {
    const view = renderStatusView(
      snapshot({
        websites: [
          { label: "example.com", url: "https://example.com", up: true, statusCode: 200, latencyMs: 118, error: null },
          { label: "caida.com", url: "https://caida.com", up: false, statusCode: 503, latencyMs: 12, error: null },
          { label: "muda.com", url: "https://muda.com", up: false, statusCode: null, latencyMs: null, error: "timeout" },
        ],
      }),
      options(),
    );

    const websites = view.blocks.find((block) => block.startsWith("🌐"));
    expect(websites).toContain("1/3");
    expect(websites).toContain("✅ example.com 118 ms");
    expect(websites).toContain("❌ caida.com 503 · 12 ms");
    expect(websites).toContain("❌ muda.com timeout");
    // Una web caida no pone el mensaje en rojo, solo en ambar.
    expect(view.level).toBe("warning");
  });

  it("respetando el bloque display del inventario", () => {
    const display: DisplayConfig = {
      ...DISPLAY,
      showGroups: false,
      showFail2banBreakdown: false,
      showPing: false,
      progressBarBlocks: 10,
    };
    const view = renderStatusView(snapshot(), options({ display }));

    const services = view.blocks.find((block) => block.startsWith("🧩"));
    expect(services).not.toContain("Infra \"");
    // Sin grupos: todos los servicios en una sola linea y sin el nombre del grupo.
    expect(services).not.toContain("\nInfra");
    expect(services).not.toContain("\nBots");

    const network = view.blocks.find((block) => block.includes("Fail2ban"));
    expect(network).toBe("🔒 Fail2ban: 37 IPs baneadas");
    expect(view.blocks.join("\n")).not.toContain("📡 RED");

    const cpu = view.blocks.find((block) => block.includes("CPU"));
    expect(cpu).toContain("🟩");
    expect(cpu?.split("\n")[1]).toMatch(/🟩+⬜+/);
  });

  it("muestra N/A y no rompe cuando una fuente falla", () => {
    const view = renderStatusView(
      snapshot({
        system: {
          cpuPercent: null,
          memory: null,
          disk: null,
          uptimeSeconds: null,
          os: null,
        },
        temperatures: [
          { source: "smartctl", name: "SSD", celsius: null, warn: 60, crit: 70, detail: "/dev/sda" },
        ],
        websites: [
          { label: "example.com", url: "https://example.com", up: true, statusCode: 200, latencyMs: null, error: null },
        ],
        fail2ban: { available: false, totalBanned: 0, jails: [], error: "sin permisos" },
        bot: { pingMs: null, uptimeSeconds: 0 },
      }),
      options(),
    );

    const text = view.blocks.join("\n");
    expect(text).toContain("N/A");
    expect(text).toContain("SSD ❔ N/A");
    expect(text).toContain("🔒 Fail2ban: sin datos");
    expect(text).toContain("✅ example.com N/A");
  });

  it("no se pasa del limite de componentes ni de caracteres", () => {
    const manyUnits = Array.from({ length: 120 }, (_, index) => ({
      unit: `servicio-muy-largo-numero-${index}`,
      state: "active" as const,
    }));
    const view = renderStatusView(
      snapshot({ services: [{ group: "Enorme", units: manyUnits }] }),
      options(),
    );

    expect(countComponents(view)).toBeLessThanOrEqual(40);
    for (const block of view.blocks) {
      expect(block.length).toBeLessThanOrEqual(4000);
    }
  });
});

describe("toComponents", () => {
  it("mete los bloques en un Container con el flag de Components V2", () => {
    const view = renderStatusView(snapshot(), options());
    const { components, flags } = toComponents(view);

    expect(flags).toBe(MessageFlags.IsComponentsV2);
    expect(components).toHaveLength(1);

    const json = components[0]?.toJSON();
    expect(json?.type).toBe(17);
    expect(json?.accent_color).toBe(0x00ff41);
    // Un TextDisplay por bloque, con un separador entre bloques.
    expect(json?.components).toHaveLength(view.blocks.length * 2 - 1);
  });
});
