import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { Inventory } from "../src/domain/entities/inventory.ts";
import { loadAppConfig, parseAppConfig, parseRequiredRoles } from "../src/infrastructure/config/env.ts";
import { loadInventory, parseInventory } from "../src/infrastructure/config/inventory.ts";
import { ConfigError } from "../src/infrastructure/config/validation.ts";

const tmpDirs: string[] = [];

function makeProject(files: { env?: string; inventory?: string | null }): string {
  const dir = mkdtempSync(join(tmpdir(), "server-status-"));
  tmpDirs.push(dir);
  if (files.env !== undefined) writeFileSync(join(dir, ".env"), files.env);
  if (files.inventory) writeFileSync(join(dir, "inventory.yaml"), files.inventory);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const MINIMAL_ENV = [
  "DISCORD_TOKEN=token-de-prueba",
  "STATUS_CHANNEL_IDS=111111111111111111",
].join("\n");

const MINIMAL_INVENTORY = [
  "websites:",
  "  - url: https://example.com",
  "services:",
  "  - group: Infra",
  "    units: [nginx, fail2ban]",
].join("\n");

/** Carga una configuracion de prueba aislada de `process.env`. */
function load(
  files: { env?: string; inventory?: string | null },
  env: Record<string, string> = {},
): { app: ReturnType<typeof loadAppConfig>; inventory: Inventory } {
  const cwd = makeProject(files);
  const app = loadAppConfig({ cwd, env });
  return { app, inventory: loadInventory(app.inventoryPath) };
}

describe("loadAppConfig + loadInventory", () => {
  it("carga un .env y un inventario validos", () => {
    const { app, inventory } = load({ env: MINIMAL_ENV, inventory: MINIMAL_INVENTORY }, {});

    expect(app.discordToken).toBe("token-de-prueba");
    expect(app.statusChannelIds).toEqual(["111111111111111111"]);
    expect(app.botDisplayName).toBe("server-status");
    expect(app.updateIntervalSeconds).toBe(300);
    expect(app.httpTimeoutMs).toBe(8000);
    expect(app.diskMount).toBe("/");
    expect(app.alertChannelId).toBeNull();
    expect(inventory.websites).toEqual([{ url: "https://example.com", label: "example.com" }]);
    expect(inventory.services).toEqual([{ group: "Infra", units: ["nginx", "fail2ban"] }]);
  });

  it("aborta si falta DISCORD_TOKEN", () => {
    expect(() =>
      load({ env: "STATUS_CHANNEL_IDS=111111111111111111", inventory: MINIMAL_INVENTORY }),
    ).toThrowError(/DISCORD_TOKEN/);
  });

  it("aborta si falta STATUS_CHANNEL_IDS o no es un id", () => {
    expect(() => load({ env: "DISCORD_TOKEN=x", inventory: MINIMAL_INVENTORY })).toThrowError(
      /STATUS_CHANNEL_IDS/,
    );
    expect(() =>
      load({
        env: "DISCORD_TOKEN=token-de-prueba\nSTATUS_CHANNEL_IDS=123",
        inventory: MINIMAL_INVENTORY,
      }),
    ).toThrowError(/STATUS_CHANNEL_IDS/);
  });

  it("admite varios canales separados por comas, sin repetidos", () => {
    const { app } = load({
      env: [
        "DISCORD_TOKEN=token-de-prueba",
        "STATUS_CHANNEL_IDS=111111111111111111, 222222222222222222,111111111111111111",
      ].join("\n"),
      inventory: MINIMAL_INVENTORY,
    });

    expect(app.statusChannelIds).toEqual(["111111111111111111", "222222222222222222"]);
  });

  it("sigue aceptando la clave singular STATUS_CHANNEL_ID", () => {
    const { app } = load({
      env: ["DISCORD_TOKEN=token-de-prueba", "STATUS_CHANNEL_ID=111111111111111111"].join("\n"),
      inventory: MINIMAL_INVENTORY,
    });

    expect(app.statusChannelIds).toEqual(["111111111111111111"]);
  });

  it("UPDATE_INTERVAL cambia de verdad el ciclo", () => {
    const env = `${MINIMAL_ENV}\nUPDATE_INTERVAL=60`;
    expect(load({ env, inventory: MINIMAL_INVENTORY }).app.updateIntervalSeconds).toBe(60);
  });

  it("aborta si UPDATE_INTERVAL no es un entero valido", () => {
    expect(() =>
      load({ env: `${MINIMAL_ENV}\nUPDATE_INTERVAL=abc`, inventory: MINIMAL_INVENTORY }),
    ).toThrowError(/UPDATE_INTERVAL/);
    expect(() =>
      load({ env: `${MINIMAL_ENV}\nUPDATE_INTERVAL=0`, inventory: MINIMAL_INVENTORY }),
    ).toThrowError(/UPDATE_INTERVAL/);
  });

  it("aborta si BOT_ACTIVITY_TYPE no es un tipo conocido", () => {
    expect(() =>
      load({ env: `${MINIMAL_ENV}\nBOT_ACTIVITY_TYPE=Volando`, inventory: MINIMAL_INVENTORY }),
    ).toThrowError(/BOT_ACTIVITY_TYPE/);
  });

  it("las variables del proceso ganan sobre el fichero .env", () => {
    const cwd = makeProject({ env: MINIMAL_ENV, inventory: MINIMAL_INVENTORY });
    const app = loadAppConfig({ cwd, env: { UPDATE_INTERVAL: "120" } });
    expect(app.updateIntervalSeconds).toBe(120);
  });

  it("resuelve las rutas relativas contra el directorio de trabajo", () => {
    const cwd = makeProject({ env: MINIMAL_ENV, inventory: MINIMAL_INVENTORY });
    const app = loadAppConfig({ cwd, env: {} });
    expect(app.inventoryPath).toBe(join(cwd, "inventory.yaml"));
    expect(app.statePath).toBe(join(cwd, "data/state.json"));
  });

  it("aborta con un mensaje claro si no existe el inventario", () => {
    expect(() => load({ env: MINIMAL_ENV })).toThrowError(/inventory\.yaml\.example/);
  });

  it("aborta si el inventario no es YAML valido", () => {
    expect(() => load({ env: MINIMAL_ENV, inventory: "websites: [ sin cerrar" })).toThrowError(
      /no es YAML valido/,
    );
  });

  it("aborta si el inventario esta vacio", () => {
    expect(() => load({ env: MINIMAL_ENV, inventory: "---\n" })).toThrowError(/vacio/);
  });

  it("aborta si falla una clave del inventario y dice cual", () => {
    const cases: Array<[string, RegExp]> = [
      ["webfnd: []\nservices:\n  - group: A\n    units: [a]", /webfnd no es una clave conocida/],
      [
        "websites:\n  - url: example.com\nservices:\n  - group: A\n    units: [a]",
        /websites\[0\]\.url/,
      ],
      ["websites: nope\nservices:\n  - group: A\n    units: [a]", /websites debe ser una lista/],
      ["services: []", /services no puede estar vacio/],
      ["services:\n  - group: A\n    units: []", /units no puede estar vacio/],
      [
        "services:\n  - group: A\n    units: [a]\ntemperatures:\n  - source: magia\n    name: CPU\n    warn: 70\n    crit: 90",
        /source debe ser "hwmon" o "smartctl"/,
      ],
      [
        "services:\n  - group: A\n    units: [a]\ntemperatures:\n  - source: hwmon\n    name: CPU\n    warn: 90\n    crit: 70\n    chip: k10temp",
        /warn \(90\) debe ser menor/,
      ],
      [
        "services:\n  - group: A\n    units: [a]\ntemperatures:\n  - source: hwmon\n    name: CPU\n    warn: 70\n    crit: 90",
        /chip debe ser un texto no vacio/,
      ],
      [
        "services:\n  - group: A\n    units: [a]\ntemperatures:\n  - source: smartctl\n    name: SSD\n    warn: 60\n    crit: 70",
        /device debe ser un texto no vacio/,
      ],
      [
        "services:\n  - group: A\n    units: [a]\n  - group: A\n    units: [a]\ndisplay:\n  colors:\n    ok: verde",
        /colors\.ok debe ser un color hex/,
      ],
      [
        "services:\n  - group: A\n    units: [a]\nalerts:\n  thresholds:\n    cpu_percent: { warn: 90, crit: 70 }",
        /cpu_percent\.warn/,
      ],
      [
        "services:\n  - group: A\n    units: [a]\ndisplay:\n  progress_bar_blocks: 40",
        /progress_bar_blocks debe ser <= 10/,
      ],
    ];

    for (const [inventory, expected] of cases) {
      expect(() => load({ env: MINIMAL_ENV, inventory }), inventory).toThrowError(expected);
    }
  });

  it("aplica los valores por defecto de display y alerts", () => {
    const inventory: Inventory = parseInventory({
      services: [{ group: "Infra", units: ["nginx"] }],
    });
    expect(inventory.display).toEqual({
      showGroups: true,
      showFail2banBreakdown: true,
      showPing: true,
      progressBarBlocks: 5,
      colors: { ok: "#00FF41", warning: "#FFAA00", critical: "#FF0040" },
    });
    expect(inventory.alerts.cooldownMinutes).toBe(30);
    expect(inventory.alerts.thresholds.ping_ms).toEqual({ warn: 100, crit: 500 });
  });

  it("lee alertas y display personalizados", () => {
    const inventory = parseInventory({
      services: [{ group: "Infra", units: ["nginx"] }],
      display: { show_groups: false, progress_bar_blocks: 8, colors: { ok: "#000000" } },
      alerts: { cooldown_minutes: 5, thresholds: { cpu_percent: { warn: 1, crit: 2 } } },
    });
    expect(inventory.display.showGroups).toBe(false);
    expect(inventory.display.progressBarBlocks).toBe(8);
    expect(inventory.display.colors).toEqual({
      ok: "#000000",
      warning: "#FFAA00",
      critical: "#FF0040",
    });
    expect(inventory.alerts.cooldownMinutes).toBe(5);
    expect(inventory.alerts.thresholds.cpu_percent).toEqual({ warn: 1, crit: 2 });
  });

  it("expone el error como ConfigError", () => {
    expect(() => parseInventory({}, "inventory.yaml")).toThrowError(ConfigError);
    expect(() => parseAppConfig({})).toThrowError(ConfigError);
  });
});

describe("plantillas versionadas", () => {
  it(".env.example e inventory.yaml.example son coherentes con el parser", () => {
    // Si el ejemplo lleva una clave que el parser rechaza, este test falla: es
    // la garantia de que la plantilla documenta variables que funcionan.
    const app = loadAppConfig({
      cwd: process.cwd(),
      envFile: ".env.example",
      env: {
        DISCORD_TOKEN: "token-de-prueba",
        STATUS_CHANNEL_ID: "111111111111111111",
        INVENTORY_PATH: "inventory.yaml.example",
      },
    });
    const inventory = loadInventory(app.inventoryPath);

    expect(app.botDisplayName).toBe("server-status");
    expect(app.activity.type).toBe("Custom");
    expect(app.activity.state).toBe("🔗 example.com");
    expect(app.updateIntervalSeconds).toBe(300);
    expect(inventory.services.length).toBeGreaterThan(0);
    expect(inventory.temperatures.length).toBeGreaterThan(0);
    expect(inventory.temperatures.some((sensor) => sensor.source === "smartctl")).toBe(true);
    expect(inventory.display.progressBarBlocks).toBe(5);
  });
});

describe("parseRequiredRoles", () => {
  it("respeta los corchetes, que forman parte del nombre del rol", () => {
    expect(parseRequiredRoles("[ServerManager],[LoCo+]")).toEqual(["[ServerManager]", "[LoCo+]"]);
  });

  it("acepta una lista mixta separada por comas", () => {
    expect(parseRequiredRoles("Administrador, Moderador,[ServerManager], [LoCo+]")).toEqual([
      "Administrador",
      "Moderador",
      "[ServerManager]",
      "[LoCo+]",
    ]);
  });

  it("admite el prefijo @ y quita repetidos", () => {
    expect(parseRequiredRoles("@Administrador,Administrador, @Moderador")).toEqual([
      "Administrador",
      "Moderador",
    ]);
  });

  it("devuelve una lista vacia si no hay roles", () => {
    expect(parseRequiredRoles(undefined)).toEqual([]);
    expect(parseRequiredRoles("  ")).toEqual([]);
  });
});
