import { MessageFlags } from "discord.js";
import { expect, describe, it } from "vitest";

import type {
  DisplaySettings,
  MetricKey,
  MetricThreshold,
  ResourceSettings,
} from "../src/domain/entities/inventory.ts";
import type { ServiceStatus } from "../src/domain/entities/service-status.ts";
import type { StatusSnapshot } from "../src/domain/entities/status-snapshot.ts";
import { displayWidth } from "../src/domain/services/format.ts";
import {
  countComponents,
  createStatusRenderer,
  MAX_LINE_WIDTH,
  MAX_RESOURCE_ROW_WIDTH,
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

/** Cuadrados de la barra: llenos o vacios. */
function hasBar(line: string): boolean {
  return line.includes("🟪") || line.includes("⬜");
}

/**
 * La barra de una fila. El flag `u` es imprescindible: sin el, la clase de
 * caracteres casaria medio emoji (un suplente suelto) en vez del cuadrado.
 */
function barOf(line: string): string {
  return /[🟪⬜]+/u.exec(line)?.[0] ?? "";
}

const DISPLAY: DisplaySettings = {
  showGroups: true,
  showFail2banBreakdown: true,
  showPing: true,
  progressBarBlocks: 10,
  colors: { ok: "#00FF41", warning: "#FFAA00", critical: "#FF0040" },
};

const THRESHOLDS: Record<MetricKey, MetricThreshold> = {
  cpu_percent: { warn: 70, crit: 90 },
  memory_percent: { warn: 70, crit: 90 },
  disk_percent: { warn: 80, crit: 95 },
  ping_ms: { warn: 100, crit: 500 },
};

/** Las seis filas del inventario real: CPU, GPU, RAM y los tres volumenes. */
const RESOURCES: ResourceSettings = {
  cpu: { label: "CPU", icon: "🧠", temperature: "CPU" },
  gpu: {
    label: "GPU",
    icon: "🎮",
    temperature: "GPU",
    busyPercentPath: "/sys/class/drm/card*/device/gpu_busy_percent",
  },
  memory: { label: "RAM", icon: "💾", temperature: null },
  disks: [
    { label: "NVME", icon: "💽", mount: "/", temperature: "NVMe" },
    { label: "SSD", icon: "📀", mount: "/mnt/ssd", temperature: "SSD" },
    { label: "HDD", icon: "🗄️", mount: "/mnt/storage", temperature: "HDD" },
  ],
};

function options(overrides: Partial<StatusRendererOptions> = {}): StatusRendererOptions {
  return {
    display: DISPLAY,
    resources: RESOURCES,
    thresholds: THRESHOLDS,
    updateIntervalSeconds: 300,
    version: "1.0.0",
    ...overrides,
  };
}

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    collectedAt: new Date(2026, 8, 14, 14, 32, 10),
    system: {
      cpuPercent: 23.1,
      gpuPercent: 0,
      memory: { percent: 22.6, usedBytes: 7.1 * 1024 ** 3, totalBytes: 31.3 * 1024 ** 3 },
      disks: [
        { mount: "/", percent: 37, usedBytes: 169.2 * 1024 ** 3, totalBytes: 456.9 * 1024 ** 3 },
        { mount: "/mnt/ssd", percent: 67.2, usedBytes: 78 * 1024 ** 3, totalBytes: 116 * 1024 ** 3 },
        {
          mount: "/mnt/storage",
          percent: 13.5,
          usedBytes: 124 * 1024 ** 3,
          totalBytes: 916 * 1024 ** 3,
        },
      ],
      uptimeSeconds: 2 * 86_400 + 3600 + 48 * 60,
      os: { hostname: "void", distro: "Ubuntu", release: "24.04", kernel: "7.0.0-31-generic" },
    },
    temperatures: [
      { source: "hwmon", name: "CPU", celsius: 45.1, warn: 75, crit: 90, detail: "k10temp Tctl" },
      { source: "hwmon", name: "GPU", celsius: 42, warn: 80, crit: 91, detail: "amdgpu edge" },
      { source: "hwmon", name: "NVMe", celsius: 36.9, warn: 70, crit: 79, detail: "nvme Composite" },
      { source: "smartctl", name: "SSD", celsius: 34, warn: 60, crit: 70, detail: "/dev/sda" },
      { source: "smartctl", name: "HDD", celsius: 30, warn: 50, crit: 60, detail: "/dev/sdb" },
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
      totalBanned: 69,
      jails: [
        { name: "dovecot", banned: 0 },
        { name: "postfix", banned: 4 },
        { name: "recidive", banned: 65 },
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

/** Las seis filas de recursos, sin la cabecera. */
function resourceRows(view: { blocks: string[] }): string[] {
  return lines(section(view, "⚙️")).slice(1);
}

function serviceLines(view: { blocks: string[] }): string[] {
  return lines(section(view, "🧩")).slice(1);
}

function fail2banLines(view: { blocks: string[] }): string[] {
  return lines(section(view, "🔒"));
}

function footerLines(view: { blocks: string[] }): string[] {
  const block = view.blocks.at(-1);
  if (block === undefined) throw new Error("no hay pie");
  return lines(block);
}

describe("renderStatusView", () => {
  it("compone el mensaje completo", () => {
    expect(renderStatusView(snapshot(), options()).blocks).toMatchSnapshot();
  });

  it("empieza en RECURSOS: no hay bloque de titulo ni seccion de temperaturas", () => {
    const view = renderStatusView(snapshot(), options());

    expect(view.blocks[0]?.startsWith("⚙️ RECURSOS")).toBe(true);
    const text = view.blocks.join("\n");
    expect(text).not.toContain("SERVER STATUS");
    expect(text).not.toContain("🌡️");
    expect(text).not.toContain("Placa");
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

  it("pinta las seis filas con su emoji, su etiqueta y su valor", () => {
    const rows = resourceRows(renderStatusView(snapshot(), options()));

    expect(rows).toHaveLength(6);
    expect(rows[0]).toContain(`🧠${NBSP}CPU`);
    expect(rows[1]).toContain(`🎮${NBSP}GPU`);
    expect(rows[2]).toContain(`💾${NBSP}RAM`);
    expect(rows[3]).toContain(`💽${NBSP}NVME`);
    expect(rows[4]).toContain(`📀${NBSP}SSD`);
    expect(rows[5]).toContain(`🗄️${NBSP}HDD`);

    // CPU y GPU llevan su `%` y su temperatura; RAM su uso y los discos sus GB.
    expect(rows[0]).toContain("23.1%");
    expect(rows[0]).toContain("45.1 °C");
    expect(rows[1]).toContain("0.0%");
    expect(rows[1]).toContain("42.0 °C");
    expect(rows[2]).toContain("22.6%");
    expect(rows[2]).toContain("7.1 GB / 31.3 GB");
    expect(rows[3]).toContain("169.2 GB / 456.9 GB");
    expect(rows[3]).toContain("36.9 °C");
    expect(rows[4]).toContain("78.0 GB / 116.0 GB");
    expect(rows[5]).toContain("124.0 GB / 916.0 GB");

    // Las filas de disco no ensenan un porcentaje de uso.
    for (const row of rows.slice(3)) {
      expect(row).not.toContain("%");
    }
  });

  it("la GPU sale sin barra ni porcentaje si no se puede leer su uso", () => {
    const view = renderStatusView(snapshot({ system: { ...snapshot().system, gpuPercent: null } }), options());
    const gpu = resourceRows(view)[1] ?? "";

    expect(hasBar(gpu)).toBe(false);
    expect(gpu).not.toContain("%");
    // Queda su temperatura, que si se ha podido leer.
    expect(gpu).toContain("42.0 °C");
  });

  it("un disco que no esta montado sale sin datos, no con los de otro volumen", () => {
    const view = renderStatusView(
      snapshot({
        system: {
          ...snapshot().system,
          // Falta /mnt/ssd: su fila no puede coger los GB de otro mount.
          disks: snapshot().system.disks.filter((disk) => disk.mount !== "/mnt/ssd"),
        },
      }),
      options(),
    );
    const ssd = resourceRows(view)[4] ?? "";

    expect(ssd).toContain(`📀${NBSP}SSD`);
    expect(ssd).toContain("N/A");
    expect(hasBar(ssd)).toBe(false);
    expect(ssd).not.toContain("%");
  });

  it("la barra pinta al menos un bloque con consumo, y ninguno con 0 %", () => {
    const view = renderStatusView(
      snapshot({
        system: {
          ...snapshot().system,
          cpuPercent: 2,
          memory: { percent: 0, usedBytes: 0, totalBytes: 1024 ** 4 },
          disks: [{ mount: "/", percent: 100, usedBytes: 1000, totalBytes: 1000 }],
        },
      }),
      options({ resources: { ...RESOURCES, disks: [RESOURCES.disks[0]!] } }),
    );

    const [cpu, , ram, nvme] = resourceRows(view);
    expect(barOf(cpu ?? "")).toBe("🟪" + "⬜".repeat(9));
    expect(barOf(nvme ?? "")).toBe("🟪".repeat(10));
    // 0 % se queda entero en blanco.
    expect(barOf(ram ?? "")).toBe("⬜".repeat(10));
  });

  it("marca la fila con la peor de sus dos lecturas", () => {
    const view = renderStatusView(
      snapshot({
        temperatures: [
          { source: "hwmon", name: "CPU", celsius: 95, warn: 75, crit: 90, detail: "k10temp Tctl" },
          { source: "hwmon", name: "GPU", celsius: 42, warn: 80, crit: 91, detail: "amdgpu edge" },
        ],
        system: { ...snapshot().system, gpuPercent: null },
      }),
      options(),
    );

    const [cpu, gpu] = resourceRows(view);
    expect(cpu).toContain("95.0 °C");
    expect(cpu).toContain("❌");
    // Sin dato de uso pero con temperatura normal: la fila no se marca.
    for (const mark of ["❌", "⚠️", "❔"]) expect(gpu).not.toContain(mark);
    expect(view.level).toBe("critical");
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

  it("RED lleva la latencia y FAIL2BAN su total y una carcel por linea", () => {
    const view = renderStatusView(snapshot(), options());

    expect(section(view, "📡")).toBe("📡 RED\nBot 42 ms");
    expect(fail2banLines(view)).toEqual([
      "🔒 FAIL2BAN · 69 IPs baneadas",
      "postfix 4",
      "recidive 65",
    ]);
  });

  it("sin desglose de fail2ban queda solo el total, y sin datos lo dice", () => {
    const noBreakdown = renderStatusView(
      snapshot(),
      options({ display: { ...DISPLAY, showFail2banBreakdown: false } }),
    );
    expect(fail2banLines(noBreakdown)).toEqual(["🔒 FAIL2BAN · 69 IPs baneadas"]);

    const noJails = renderStatusView(
      snapshot({
        fail2ban: { available: true, totalBanned: 0, jails: [{ name: "sshd", banned: 0 }], error: null },
      }),
      options(),
    );
    expect(fail2banLines(noJails)).toEqual(["🔒 FAIL2BAN · 0 IPs baneadas"]);

    const unavailable = renderStatusView(
      snapshot({ fail2ban: { available: false, totalBanned: 0, jails: [], error: "sin permisos" } }),
      options(),
    );
    expect(fail2banLines(unavailable)).toEqual(["🔒 FAIL2BAN · sin datos"]);
  });

  it("el pie lleva dos lineas: el sistema y la actualizacion", () => {
    const footer = footerLines(renderStatusView(snapshot(), options()));

    expect(footer).toEqual([
      "Ubuntu 24.04 · 7.0.0-31-generic · 2d 01h 48m",
      "Actualizado cada 5 min · última 14:32 · v1.0.0",
    ]);
  });

  it("el uptime del pie va con horas y minutos a dos digitos", () => {
    const view = renderStatusView(
      snapshot({ system: { ...snapshot().system, uptimeSeconds: 3600 + 60 } }),
      options(),
    );
    expect(footerLines(view)[0]).toContain("01h 01m");
    expect(footerLines(view)[0]).not.toContain("d ");
  });

  it("respetando el bloque display del inventario", () => {
    const display: DisplaySettings = {
      ...DISPLAY,
      showGroups: false,
      showFail2banBreakdown: false,
      showPing: false,
    };
    const view = renderStatusView(snapshot(), options({ display }));

    // Sin grupos no aparece el nombre de ninguno.
    expect(serviceLines(view).some((row) => row.startsWith("Infra"))).toBe(false);
    expect(serviceLines(view).some((row) => row.startsWith("Bots"))).toBe(false);

    const text = view.blocks.join("\n");
    expect(text).not.toContain("📡 RED");
    expect(text).toContain("🔒 FAIL2BAN · 69 IPs baneadas");
  });

  it("una barra con otro numero de bloques sale del inventario", () => {
    const view = renderStatusView(snapshot(), options({ display: { ...DISPLAY, progressBarBlocks: 5 } }));
    // 23.1 % de 5 bloques: 1 lleno (y la barra ocupa 5, no 10).
    expect(barOf(resourceRows(view)[0] ?? "")).toBe("🟪⬜⬜⬜⬜");
  });

  it("muestra N/A y no rompe cuando una fuente falla", () => {
    const view = renderStatusView(
      snapshot({
        system: {
          cpuPercent: null,
          gpuPercent: null,
          memory: null,
          disks: [],
          uptimeSeconds: null,
          os: null,
        },
        temperatures: [
          { source: "smartctl", name: "HDD", celsius: null, warn: 50, crit: 60, detail: "/dev/sdb" },
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
    expect(text).toContain("🔒 FAIL2BAN · sin datos");
    expect(text).toContain("✅ example.com N/A");

    const rows = resourceRows(view);
    // Ni CPU ni RAM ni los discos: todas las filas salen sin barra.
    for (const row of rows) expect(hasBar(row)).toBe(false);
    expect(rows[0]).toContain("N/A");
    // El HDD no se ha podido leer: su temperatura tambien es N/A.
    expect(rows[5]).toContain(`❔`);
    // El pie no se rompe sin sistema operativo.
    expect(footerLines(view)[0]).toContain("N/A");
  });

  it("ninguna linea de las listas se pasa del ancho que promete el render", () => {
    for (const showGroups of [true, false]) {
      const view = renderStatusView(snapshot(), options({ display: { ...DISPLAY, showGroups } }));
      for (const block of view.blocks) {
        for (const line of lines(block)) {
          // La tabla de recursos no se empaqueta: tiene su propio presupuesto.
          if (block.startsWith("⚙️")) continue;
          expect(displayWidth(line)).toBeLessThanOrEqual(MAX_LINE_WIDTH);
        }
      }
    }
  });

  it("cada fila de recursos es una sola linea y cabe en su presupuesto", () => {
    const view = renderStatusView(snapshot(), options());

    for (const row of resourceRows(view)) {
      expect(displayWidth(row)).toBeLessThanOrEqual(MAX_RESOURCE_ROW_WIDTH);
      expect(row.trim()).not.toBe("");
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
