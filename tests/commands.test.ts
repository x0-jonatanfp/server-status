import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PermissionFlagsBits } from "discord.js";
import { afterAll, describe, expect, it, vi } from "vitest";

import { InvalidIpError, type Fail2banUnbanResult } from "../src/collectors/fail2ban.ts";
import type { StatusSnapshot } from "../src/collectors/index.ts";
import { commandNames, commands, findCommand } from "../src/commands/index.ts";
import type {
  CommandContext,
  CommandInteraction,
  CommandReply,
} from "../src/commands/types.ts";
import { parseAppConfig, parseInventory } from "../src/config.ts";
import { Scheduler, type StatusPublisher } from "../src/scheduler.ts";
import { StateStore } from "../src/store.ts";

const CHANNEL = "111111111111111111";
const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "server-status-commands-"));
  tmpDirs.push(dir);
  return join(dir, "state.json");
}

function snapshot(): StatusSnapshot {
  return {
    collectedAt: new Date(2026, 8, 14, 14, 32, 10),
    system: { cpuPercent: 12.4, memory: null, disk: null, uptimeSeconds: 3600, os: null },
    temperatures: [],
    services: [],
    websites: [],
    fail2ban: { available: true, totalBanned: 0, jails: [], error: null },
    bot: { pingMs: 42, uptimeSeconds: 3600 },
  };
}

/** Interaccion de mentira: solo guarda lo que el comando responde. */
class FakeInteraction implements CommandInteraction {
  readonly replies: CommandReply[] = [];
  readonly channelId = CHANNEL;
  roles: string[] = ["ServerManager"];

  constructor(private readonly options: Record<string, string | boolean> = {}) {}

  getString(name: string): string | null {
    const value = this.options[name];
    return typeof value === "string" ? value : null;
  }

  getBoolean(name: string): boolean {
    return this.options[name] === true;
  }

  roleNames(): string[] {
    return this.roles;
  }

  async reply(reply: CommandReply): Promise<void> {
    this.replies.push(reply);
    return Promise.resolve();
  }
}

class FakePublisher implements StatusPublisher {
  readonly messages = new Map<string, unknown>();
  runs = 0;

  async publish(_channelId: string, view: unknown, existing: string | null) {
    this.runs += 1;
    const id = existing && this.messages.has(existing) ? existing : `mensaje-${this.messages.size + 1}`;
    const created = !this.messages.has(id);
    this.messages.set(id, view);
    return { messageId: id, created };
  }
}

interface Harness {
  context: CommandContext;
  publisher: FakePublisher;
  unban: ReturnType<typeof vi.fn>;
  store: StateStore;
}

function harness(overrides: { requiredRoles?: string[] } = {}): Harness {
  const config = {
    ...parseAppConfig({
      DISCORD_TOKEN: "token",
      STATUS_CHANNEL_ID: CHANNEL,
      REQUIRED_ROLES: overrides.requiredRoles ? `[${overrides.requiredRoles.join("],[")}]` : undefined,
    }),
    inventoryPath: "inventory.yaml",
  };
  const inventory = parseInventory({ services: [{ group: "Infra", units: ["nginx"] }] });
  const publisher = new FakePublisher();
  const store = new StateStore({ path: tmpStatePath() });
  const scheduler = new Scheduler({
    updateIntervalSeconds: config.updateIntervalSeconds,
    channelId: CHANNEL,
    collect: async () => snapshot(),
    render: () => ({ blocks: ["🟢 SERVER STATUS"], level: "ok", accentColor: 0x00ff41 }),
    publisher,
    store,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
  const unban = vi.fn(
    async (ip: string): Promise<Fail2banUnbanResult> => ({
      ip,
      jails: [
        { name: "sshd", ok: true, error: null },
        { name: "recidive", ok: true, error: null },
      ],
    }),
  );

  return {
    publisher,
    unban,
    store,
    context: {
      config,
      inventory,
      scheduler,
      store,
      collect: async () => snapshot(),
      render: () => ({ blocks: ["🟢 SERVER STATUS"], level: "ok", accentColor: 0x00ff41 }),
      unban,
      gatewayPingMs: () => 42,
      version: "1.0.0",
      startedAt: new Date(2026, 8, 14, 12, 0, 0),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
  };
}

async function run(
  name: string,
  interaction: FakeInteraction,
  context: CommandContext,
): Promise<CommandReply[]> {
  const command = findCommand(name);
  if (!command) throw new Error(`no existe el comando ${name}`);
  await command.execute(interaction, context);
  return interaction.replies;
}

describe("registro de comandos", () => {
  it("registra exactamente los seis comandos del plan", () => {
    expect(commandNames).toEqual([
      "status",
      "set_channel",
      "update",
      "botstatus",
      "unban",
      "help-unban",
    ]);
    expect(new Set(commandNames).size).toBe(commandNames.length);
  });

  it("todos tienen descripcion y los de administracion piden Administrator", () => {
    for (const command of commands) {
      const json = command.data.toJSON();
      expect(json.description.length).toBeGreaterThan(0);
      if (["set_channel", "update", "botstatus"].includes(json.name)) {
        expect(json.default_member_permissions).toBe(String(PermissionFlagsBits.Administrator));
      } else {
        expect(json.default_member_permissions).toBeUndefined();
      }
    }
  });

  it("/unban exige la IP y /set_channel acepta un canal opcional", () => {
    const unban = findCommand("unban")?.data.toJSON();
    expect(unban?.options?.[0]).toMatchObject({ name: "ip", required: true, type: 3 });

    const setChannel = findCommand("set_channel")?.data.toJSON();
    expect(setChannel?.options?.[0]).toMatchObject({ name: "canal", type: 7 });
  });
});

describe("/status", () => {
  it("responde en privado con la vista renderizada", async () => {
    const replies = await run("status", new FakeInteraction(), harness().context);

    expect(replies).toHaveLength(1);
    expect(replies[0]?.view?.blocks).toEqual(["🟢 SERVER STATUS"]);
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it("responde en el canal si se pide publico", async () => {
    const replies = await run("status", new FakeInteraction({ publico: true }), harness().context);
    expect(replies[0]?.ephemeral).toBe(false);
  });

  it("niega el comando a quien no tiene los roles configurados", async () => {
    const { context } = harness({ requiredRoles: ["ServerManager"] });
    const interaction = new FakeInteraction();
    interaction.roles = ["Invitado"];

    const replies = await run("status", interaction, context);

    expect(replies[0]?.content).toContain("No tienes permiso");
    expect(replies[0]?.view).toBeUndefined();
  });
});

describe("/set_channel", () => {
  it("fija el canal, lo persiste y publica el mensaje", async () => {
    const { context, publisher, store } = harness();
    const replies = await run("set_channel", new FakeInteraction({ canal: CHANNEL }), context);

    expect(replies[0]?.content).toContain(`<#${CHANNEL}>`);
    expect(context.scheduler.channelId).toBe(CHANNEL);
    expect(await store.getStatusChannelId()).toBe(CHANNEL);
    expect(publisher.messages.size).toBe(1);
  });

  it("usa el canal actual si no se indica ninguno y rechaza un id invalido", async () => {
    const { context } = harness();
    const current = await run("set_channel", new FakeInteraction(), context);
    expect(current[0]?.content).toContain(`<#${CHANNEL}>`);

    const invalid = await run("set_channel", new FakeInteraction({ canal: "no-soy-un-id" }), context);
    expect(invalid[0]?.content).toContain("no es un id de canal valido");
  });
});

describe("/update", () => {
  it("fuerza un ciclo y lo informa", async () => {
    const { context, publisher } = harness();
    const replies = await run("update", new FakeInteraction(), context);

    expect(publisher.runs).toBe(1);
    expect(replies[0]?.content).toContain("mensaje creado");
  });

  it("informa del error si el ciclo falla", async () => {
    const { context } = harness();
    const failing = new Scheduler({
      updateIntervalSeconds: 300,
      channelId: CHANNEL,
      collect: async () => {
        throw new Error("sin datos");
      },
      render: () => ({ blocks: [], level: "ok", accentColor: 0 }),
      publisher: new FakePublisher(),
      store: new StateStore({ path: tmpStatePath() }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    const replies = await run("update", new FakeInteraction(), { ...context, scheduler: failing });
    expect(replies[0]?.content).toContain("sin datos");
  });
});

describe("/botstatus", () => {
  it("informa del bucle, la latencia y la ultima publicacion", async () => {
    const { context } = harness();
    await context.scheduler.runOnce("manual");
    const replies = await run("botstatus", new FakeInteraction(), context);

    const content = replies[0]?.content ?? "";
    expect(content).toContain(context.config.botDisplayName);
    expect(content).toContain("v1.0.0");
    expect(content).toContain("cada 5 min");
    expect(content).toContain("Latencia del gateway: 42 ms");
    expect(content).toContain("Última publicación:");
    expect(replies[0]?.ephemeral).toBe(true);
  });
});

describe("/unban", () => {
  it("desbanea la IP y resume el resultado", async () => {
    const { context, unban } = harness();
    const replies = await run("unban", new FakeInteraction({ ip: "203.0.113.7" }), context);

    expect(unban).toHaveBeenCalledWith("203.0.113.7");
    expect(replies[0]?.content).toContain("2/2 cárceles");
  });

  it("informa de las carceles que fallan", async () => {
    const { context, unban } = harness();
    unban.mockResolvedValueOnce({
      ip: "203.0.113.7",
      jails: [
        { name: "sshd", ok: true, error: null },
        { name: "recidive", ok: false, error: "no se pudo" },
      ],
    });

    const replies = await run("unban", new FakeInteraction({ ip: "203.0.113.7" }), context);
    expect(replies[0]?.content).toContain("1/2 cárceles");
    expect(replies[0]?.content).toContain("recidive");
  });

  it("rechaza una IP invalida con el motivo y sin lanzar", async () => {
    const { context, unban } = harness();
    unban.mockRejectedValueOnce(new InvalidIpError("no-es-ip"));

    const replies = await run("unban", new FakeInteraction({ ip: "no-es-ip" }), context);

    expect(replies[0]?.content).toContain("no es una IP valida");
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it("informa de un fallo inesperado de fail2ban", async () => {
    const { context, unban } = harness();
    unban.mockRejectedValueOnce(new Error("fail2ban no responde"));

    const replies = await run("unban", new FakeInteraction({ ip: "203.0.113.7" }), context);
    expect(replies[0]?.content).toContain("fail2ban no responde");
  });

  it("niega el desbaneo a quien no tiene permiso y no llama a fail2ban", async () => {
    const { context, unban } = harness({ requiredRoles: ["ServerManager"] });
    const interaction = new FakeInteraction({ ip: "203.0.113.7" });
    interaction.roles = [];

    const replies = await run("unban", interaction, context);

    expect(replies[0]?.content).toContain("No tienes permiso");
    expect(unban).not.toHaveBeenCalled();
  });
});

describe("/help-unban", () => {
  it("explica el desbaneo y los roles con permiso", async () => {
    const { context } = harness({ requiredRoles: ["ServerManager"] });
    const replies = await run("help-unban", new FakeInteraction(), context);

    const content = replies[0]?.content ?? "";
    expect(content).toContain("/unban <ip>");
    expect(content).toContain("ServerManager");
  });
});
