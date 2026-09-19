import { MessageFlags } from "discord.js";
import { expect, describe, it } from "vitest";

import type {
  DisplaySettings,
  MetricKey,
  MetricThreshold,
} from "../src/domain/entities/inventory.ts";
import type { ServiceStatus } from "../src/domain/entities/service-status.ts";
import type { StatusSnapshot } from "../src/domain/entities/status-snapshot.ts";
import { displayWidth } from "../src/domain/services/format.ts";
import {
  countComponents,
  createStatusRenderer,
  MAX_LINE_WIDTH,
  renderStatusView,
  toComponents,
  type StatusRendererOptions,
} from "../src/infrastructure/discord/status-view.ts";

/** Espacio duro: es el que impide que Discord parta una entrada de la lista. */
const NBSP = "\u00A0";

/** Emoji de estado que puede abrir una entrada de servicio. */
const STATE_MARKS = ["✅", "❌", "⚠️", "❔"];

/** Columna donde arranca la primera marca de estado de una linea. */
function markColumn(line: string): number {
  const columns = STATE_MARKS.map((mark) => line.indexOf(mark)).filter((index) => index >= 0);
  return columns.length === 0 ? -1 : Math.min(...columns);
}

function endsWithMark(line: string): boolean {
  return STATE_MARKS.some((mark) => line.endsWith(mark));
}

const DISPLAY: DisplaySettings = {
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

function options(overrides: Partial<StatusRendererOptions> = {}): StatusRendererOptions {
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
      os: { hostname: "void", distro: "Ubuntu", release: "24.04", kernel: "7.0.0" },
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

/** Bloque del mensaje que empieza por el emoji indicado. */
function section(view: { blocks: string[] }, emoji: string): string {
  const block = view.blocks.find((candidate) => candidate.startsWith(emoji));
  if (block === undefined) throw new Error(`no hay bloque que empiece por ${emoji}`);
  return block;
}

function lines(block: string): string[] {
  return block.split("\n");
}

/** Filas de la tabla de recursos, sin las cabeceras ni las vallas del codigo. */
function resourceRows(view: { blocks: string[] }): string[] {
  const all = lines(section(view, "⚙️"));
  expect(all[1]).toBe("```");
  expect(all.at(-1)).toBe("```");
  return all.slice(2, -1);
}

function serviceLines(view: { blocks: string[] }): string[] {
  return lines(section(view, "🧩")).slice(1);
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

  it("muestra la version base de la distribucion", () => {
    const view = renderStatusView(
      snapshot({
        system: {
          ...snapshot().system,
          os: { hostname: "void", distro: "Ubuntu", release: "24.04.5 LTS", kernel: "7.0.0" },
        },
      }),
      options(),
    );

    expect(view.blocks[0]).toContain("example.com · Ubuntu 24.04 · kernel 7.0.0");
  });

  it("la tabla de recursos va en un bloque de codigo y alinea las columnas", () => {
    const view = renderStatusView(
      snapshot({
        system: {
          ...snapshot().system,
          // 1, 2 y 3 digitos (mas el caso "100.0%") en el mismo mensaje.
          cpuPercent: 7.2,
          memory: { percent: 18.4, usedBytes: 5.8 * 1024 ** 3, totalBytes: 31.3 * 1024 ** 3 },
          disk: {
            mount: "/",
            percent: 100,
            usedBytes: 456.9 * 1024 ** 3,
            totalBytes: 456.9 * 1024 ** 3,
          },
        },
      }),
      options(),
    );

    const rows = resourceRows(view);
    expect(rows).toHaveLength(3);
    expect(section(view, "⚙️")).toContain("7.2%");
    expect(section(view, "⚙️")).toContain("100.0%");
    // Nada de emoji dentro de la tabla: romperian el monoespaciado.
    expect(section(view, "⚙️")).not.toMatch(/🧠|💾|💽|🟪|⬜/);

    // La barra empieza en la misma columna en las tres filas...
    expect(new Set(rows.map((row) => row.search(/[█░]/))).size).toBe(1);
    // ...y el porcentaje termina en la misma columna tenga uno, dos o tres
    // digitos (los numeros van alineados a la derecha, como en una tabla).
    expect(
      new Set(
        rows.map((row) => {
          const match = /\d+\.\d%/.exec(row);
          return (match?.index ?? -1) + (match?.[0].length ?? 0);
        }),
      ).size,
    ).toBe(1);
    // El detalle ("5.8 GB / 31.3 GB") tambien arranca en la misma columna en
    // las filas que lo tienen (la CPU no lo lleva).
    const detailStarts = rows.map(
      (row) => /[\d.]+ (?:GB|TB|MB|KB|B) \/ [\d.]+ (?:GB|TB|MB|KB|B)/.exec(row)?.index ?? -1,
    );
    const withDetail = detailStarts.filter((column) => column >= 0);
    expect(withDetail).toHaveLength(2);
    expect(new Set(withDetail).size).toBe(1);
  });

  it("la tabla sigue alineada cuando falta el dato (N/A)", () => {
    const view = renderStatusView(
      snapshot({
        // Una fila sin dato entre dos que si lo tienen: la columna no se mueve.
        system: {
          ...snapshot().system,
          cpuPercent: null,
          memory: { percent: 18.4, usedBytes: 5.8 * 1024 ** 3, totalBytes: 31.3 * 1024 ** 3 },
          disk: null,
        },
      }),
      options(),
    );

    const rows = resourceRows(view);
    expect(section(view, "⚙️")).toContain("N/A");
    // La barra vacia ocupa el mismo sitio que con un valor real.
    expect(new Set(rows.map((row) => row.search(/[█░]/))).size).toBe(1);
    // El porcentaje termina en la misma columna tenga dato o no: `N/A` se
    // rellena por la izquierda hasta las 6 columnas de "100.0%".
    const ends = rows.map((row) => {
      const match = /(N\/A|\d+\.\d%)/.exec(row);
      return (match?.index ?? -1) + (match?.[0].length ?? 0);
    });
    expect(new Set(ends).size).toBe(1);
    expect(ends[0]).toBeGreaterThan(0);
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

    const services = section(view, "🧩");
    expect(services).toContain("1/4 activos");
    expect(services).toContain(`❌${NBSP}fail2ban`);
    expect(services).toContain(`⚠️${NBSP}redis-server`);
    expect(services).toContain(`❔${NBSP}fantasma`);
  });

  it("empaqueta los servicios sin partir ninguna entrada, con grupos y sin ellos", () => {
    const units: ServiceStatus[] = [
      "nginx",
      "fail2ban",
      "postgresql@16-main",
      "redis-server",
      "dovecot",
      "postfix@-",
      "rspamd",
      "clamav-daemon",
      "unbound",
      "smbd",
      "nmbd",
      "example",
      "app-pixel",
      "auth-service",
      "tg-gateway",
      "ig-gateway",
      "mail-relay",
      "void-agent",
      "f2b_private_bot",
      "server-status",
    ].map((unit) => ({ unit, state: "active" as const }));

    const services = [
      { group: "Infra", units: units.slice(0, 11) },
      { group: "Apps", units: units.slice(11, 17) },
      { group: "Bots", units: units.slice(17) },
    ];

    for (const showGroups of [true, false]) {
      const view = renderStatusView(
        snapshot({ services }),
        options({ display: { ...DISPLAY, showGroups } }),
      );
      const rows = serviceLines(view);

      // Cada entrada es un bloque indivisible: un solo espacio duro por unidad.
      expect(rows.join("\n").split(NBSP)).toHaveLength(units.length + 1);
      // Ninguna linea se pasa del ancho prometido ni termina en un emoji
      // huerfano con el nombre del servicio en la linea siguiente.
      for (const row of rows) {
        expect(displayWidth(row)).toBeLessThanOrEqual(MAX_LINE_WIDTH);
        expect(endsWithMark(row)).toBe(false);
        expect(row.trim()).not.toBe("");
      }
      // Los nombres largos quedan enteros en una linea.
      expect(rows.some((row) => row.includes(`✅${NBSP}postgresql@16-main`))).toBe(true);
      expect(rows.some((row) => row.includes(`✅${NBSP}f2b_private_bot`))).toBe(true);
      // Con grupos, cada linea empieza por su etiqueta o por la indentacion.
      if (showGroups) {
        expect(rows.some((row) => row.startsWith("Infra "))).toBe(true);
        expect(rows.some((row) => row.startsWith("Apps  "))).toBe(true);
        expect(rows.some((row) => row.startsWith("Bots  "))).toBe(true);
        // Las continuaciones van alineadas con la primera entrada del grupo.
        expect(new Set(rows.map(markColumn)).size).toBe(1);
      } else {
        expect(rows.some((row) => row.startsWith("Infra"))).toBe(false);
        expect(rows.every((row) => row.startsWith("✅") || row.includes("✅"))).toBe(true);
      }
    }
  });

  it("las temperaturas se empaquetan sin pasar del ancho", () => {
    const view = renderStatusView(
      snapshot({
        temperatures: Array.from({ length: 8 }, (_, index) => ({
          source: "hwmon" as const,
          name: `Sensor-${index}`,
          celsius: 40 + index,
          warn: 70,
          crit: 90,
          detail: "hwmon",
        })),
      }),
      options(),
    );

    const rows = lines(section(view, "🌡️")).slice(1);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(displayWidth(row)).toBeLessThanOrEqual(MAX_LINE_WIDTH);
      expect(row.endsWith(" · ")).toBe(false);
    }
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

    const websites = section(view, "🌐");
    expect(websites).toContain("1/3");
    expect(websites).toContain("✅ example.com 118 ms");
    expect(websites).toContain("❌ caida.com 503 · 12 ms");
    expect(websites).toContain("❌ muda.com timeout");
    // Una web caida no pone el mensaje en rojo, solo en ambar.
    expect(view.level).toBe("warning");
  });

  it("respetando el bloque display del inventario", () => {
    const display: DisplaySettings = {
      ...DISPLAY,
      showGroups: false,
      showFail2banBreakdown: false,
      showPing: false,
      progressBarBlocks: 10,
    };
    const view = renderStatusView(snapshot(), options({ display }));

    // Sin grupos no aparece el nombre de ninguno.
    expect(serviceLines(view).some((row) => row.startsWith("Infra"))).toBe(false);
    expect(serviceLines(view).some((row) => row.startsWith("Bots"))).toBe(false);

    const network = view.blocks.find((block) => block.includes("Fail2ban"));
    expect(network).toBe("🔒 Fail2ban: 37 IPs baneadas");
    expect(view.blocks.join("\n")).not.toContain("📡 RED");

    // La barra tiene los 10 bloques del inventario y es de caracteres fijos.
    const cpu = resourceRows(view)[0];
    expect(cpu).toContain("█");
    expect(cpu).toContain("░");
    expect(cpu?.match(/[█░]+/)?.[0]).toHaveLength(10);
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
    expect(text).toContain(`SSD${NBSP}❔${NBSP}N/A`);
    expect(text).toContain("🔒 Fail2ban: sin datos");
    expect(text).toContain("✅ example.com N/A");
  });

  it("ninguna linea se pasa del ancho que promete el render", () => {
    for (const showGroups of [true, false]) {
      const view = renderStatusView(snapshot(), options({ display: { ...DISPLAY, showGroups } }));
      for (const block of view.blocks) {
        for (const line of lines(block)) {
          expect(displayWidth(line)).toBeLessThanOrEqual(MAX_LINE_WIDTH);
        }
      }
    }
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
    for (const row of serviceLines(view)) {
      expect(displayWidth(row)).toBeLessThanOrEqual(MAX_LINE_WIDTH);
    }
  });
});

describe("createStatusRenderer", () => {
  it("implementa el puerto de render con la configuracion ya fijada", () => {
    const renderer = createStatusRenderer(options());
    expect(renderer.render(snapshot())).toEqual(renderStatusView(snapshot(), options()));
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
