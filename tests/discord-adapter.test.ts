import { ActivityType, MessageFlags, type ChatInputCommandInteraction, type Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { StatusView } from "../src/domain/entities/status-view.ts";
import { ACTIVITY_TYPE_NAMES, type ActivityConfig } from "../src/infrastructure/config/env.ts";
import {
  buildActivity,
  createBotStatusPort,
  createShutdown,
  registerCommands,
  SHUTDOWN_TIMEOUT_MS,
  toCommandInteraction,
} from "../src/infrastructure/discord/client.ts";
import {
  createDiscordAlertNotifier,
  createDiscordPublisher,
  formatAlerts,
  isUnknownMessage,
  type ChannelResolver,
  type StatusChannel,
} from "../src/infrastructure/discord/publisher.ts";

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function view(): StatusView {
  return { blocks: ["🟢 SERVER STATUS"], level: "ok", accentColor: 0x00ff41 };
}

/** Canal de mentira: guarda los mensajes y falla al editar los que no existen. */
function fakeChannel(messages = new Map<string, StatusView>()): {
  channel: StatusChannel;
  messages: Map<string, StatusView>;
  sends: number;
  edits: number;
} {
  const state = { sends: 0, edits: 0 };
  const channel: StatusChannel = {
    async send() {
      state.sends += 1;
      const id = `mensaje-${messages.size + 1}`;
      messages.set(id, view());
      return { id };
    },
    messages: {
      async fetch(id: string) {
        if (!messages.has(id)) {
          throw Object.assign(new Error("Unknown Message"), { code: 10008 });
        }
        return {
          async edit() {
            state.edits += 1;
          },
        };
      },
    },
  };
  return {
    channel,
    messages,
    get sends() {
      return state.sends;
    },
    get edits() {
      return state.edits;
    },
  };
}

describe("createShutdown", () => {
  it("para el bucle, cierra el cliente y sale con 0 en menos de 5 s", async () => {
    const calls: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown({
      stopLoop: async () => {
        calls.push("stop");
      },
      destroyClient: () => {
        calls.push("destroy");
      },
      logger: logger(),
      exit,
    });

    const started = Date.now();
    await shutdown("SIGTERM");

    expect(calls).toEqual(["stop", "destroy"]);
    expect(exit).toHaveBeenCalledWith(0);
    expect(Date.now() - started).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
  });

  it("no vuelve a apagar nada si se repite la senal", async () => {
    const stopLoop = vi.fn(async () => undefined);
    const exit = vi.fn();
    const shutdown = createShutdown({
      stopLoop,
      destroyClient: () => undefined,
      logger: logger(),
      exit,
    });

    await Promise.all([shutdown("SIGINT"), shutdown("SIGTERM")]);

    expect(stopLoop).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("no se cuelga si el apagado se atasca", async () => {
    const exit = vi.fn();
    const shutdown = createShutdown({
      stopLoop: () => new Promise(() => undefined),
      destroyClient: () => undefined,
      logger: logger(),
      timeoutMs: 30,
      exit,
    });

    await shutdown("SIGINT");

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("informa si el apagado falla", async () => {
    const log = logger();
    const exit = vi.fn();
    const shutdown = createShutdown({
      stopLoop: async () => {
        throw new Error("el bucle no responde");
      },
      destroyClient: () => undefined,
      logger: log,
      exit,
    });

    await shutdown("SIGTERM");

    expect(log.error).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("buildActivity", () => {
  const base: ActivityConfig = { type: "Custom", name: "example.com", state: "🔗 example.com", url: null };

  it("mapea los seis tipos de actividad", () => {
    const expected: Record<string, ActivityType> = {
      Playing: ActivityType.Playing,
      Streaming: ActivityType.Streaming,
      Listening: ActivityType.Listening,
      Watching: ActivityType.Watching,
      Custom: ActivityType.Custom,
      Competing: ActivityType.Competing,
    };
    for (const type of ACTIVITY_TYPE_NAMES) {
      expect(buildActivity({ ...base, type }).type).toBe(expected[type]);
    }
  });

  it("con Custom lleva el estado personalizado y no la url", () => {
    const activity = buildActivity({ ...base, url: "https://twitch.tv/algo" });
    expect(activity.state).toBe("🔗 example.com");
    expect(activity.url).toBeUndefined();
  });

  it("con Streaming lleva la url", () => {
    const activity = buildActivity({
      ...base,
      type: "Streaming",
      url: "https://twitch.tv/example",
    });
    expect(activity.type).toBe(ActivityType.Streaming);
    expect(activity.url).toBe("https://twitch.tv/example");
  });
});

describe("createBotStatusPort", () => {
  it("normaliza la latencia del gateway y el uptime", () => {
    const client = { isReady: () => true, ws: { ping: 42 } } as unknown as Client;
    expect(createBotStatusPort(client).status()).toMatchObject({ pingMs: 42 });
  });

  it("devuelve null si el cliente aun no esta listo", () => {
    const client = { isReady: () => false, ws: { ping: -1 } } as unknown as Client;
    expect(createBotStatusPort(client).status().pingMs).toBeNull();
  });
});

describe("createDiscordPublisher", () => {
  it("edita el mensaje guardado y no crea otro", async () => {
    const messages = new Map<string, StatusView>([["mensaje-1", view()]]);
    const fake = fakeChannel(messages);
    const resolver: ChannelResolver = { resolve: async () => fake.channel };
    const publisher = createDiscordPublisher(resolver, logger());

    const result = await publisher.publish("123", view(), "mensaje-1");

    expect(result).toEqual({ messageId: "mensaje-1", created: false });
    expect(fake.sends).toBe(0);
    expect(fake.edits).toBe(1);
  });

  it("reenvia si el mensaje ya no existe", async () => {
    const fake = fakeChannel();
    const publisher = createDiscordPublisher({ resolve: async () => fake.channel }, logger());

    const result = await publisher.publish("123", view(), "mensaje-borrado");

    expect(result.created).toBe(true);
    expect(result.messageId).toBe("mensaje-1");
    expect(fake.sends).toBe(1);
  });

  it("no traga con otros errores de Discord", async () => {
    const channel: StatusChannel = {
      send: async () => ({ id: "x" }),
      messages: {
        fetch: async () => {
          throw Object.assign(new Error("Missing Permissions"), { code: 50013 });
        },
      },
    };
    const publisher = createDiscordPublisher({ resolve: async () => channel }, logger());

    await expect(publisher.publish("123", view(), "mensaje-1")).rejects.toThrowError(
      "Missing Permissions",
    );
  });

  it("falla con un mensaje claro si el canal no existe", async () => {
    const publisher = createDiscordPublisher({ resolve: async () => null }, logger());

    await expect(publisher.publish("123", view(), null)).rejects.toThrowError(/no existe/);
  });
});

describe("isUnknownMessage", () => {
  it("solo reconoce el codigo de mensaje desconocido", () => {
    expect(isUnknownMessage({ code: 10008 })).toBe(true);
    expect(isUnknownMessage({ code: 50013 })).toBe(false);
    expect(isUnknownMessage(new Error("otra cosa"))).toBe(false);
    expect(isUnknownMessage(null)).toBe(false);
  });
});

describe("formatAlerts y su notificador", () => {
  const alerts = [
    { key: "temperature:GPU", severity: "critical" as const, title: "🌡️ GPU caliente", detail: "95.0 °C" },
    { key: "metric:cpu_percent", severity: "warning" as const, title: "🧠 CPU fuera de rango", detail: "75.0 %" },
  ];

  it("marca la gravedad y explica el umbral", () => {
    const text = formatAlerts(alerts);

    expect(text).toContain("🔴 **🌡️ GPU caliente**");
    expect(text).toContain("🟠 **🧠 CPU fuera de rango**");
  });

  it("manda las alertas al canal configurado", async () => {
    const sent: string[] = [];
    const resolver: ChannelResolver = {
      resolve: async () => ({
        send: async (payload) => {
          sent.push(String((payload as { content?: string }).content ?? ""));
          return { id: "1" };
        },
        messages: { fetch: async () => ({ edit: async () => undefined }) },
      }),
    };

    await createDiscordAlertNotifier({
      resolver,
      alertChannelId: "111111111111111111",
      logger: logger(),
    }).notify(alerts);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("GPU caliente");
  });

  it("avisa por el log y no falla si no hay canal de alertas", async () => {
    const log = logger();
    const notifier = createDiscordAlertNotifier({
      resolver: { resolve: async () => null },
      alertChannelId: null,
      logger: log,
    });

    await expect(notifier.notify(alerts)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledOnce();
  });
});

describe("registerCommands", () => {
  function readyClient() {
    const set = vi.fn(async (_commands: unknown, _guildId?: string) => undefined);
    return { client: { application: { commands: { set } } }, set };
  }

  it("sincroniza por guild para que aparezcan al momento", async () => {
    const { client, set } = readyClient();
    const log = logger();

    await registerCommands(client as never, "111111111111111111", log);

    expect(set).toHaveBeenCalledOnce();
    expect(set.mock.calls[0]?.[1]).toBe("111111111111111111");
    expect(set.mock.calls[0]?.[0]).toHaveLength(6);
  });

  it("cae a global y lo avisa si no hay GUILD_ID", async () => {
    const { client, set } = readyClient();
    const log = logger();

    await registerCommands(client as never, null, log);

    expect(set.mock.calls[0]?.[1]).toBeUndefined();
    expect(log.warn).toHaveBeenCalledOnce();
  });
});

describe("toCommandInteraction", () => {
  function fakeInteraction(options: Record<string, unknown> = {}, roleNames: string[] = []) {
    const reply = vi.fn(async (_payload?: unknown) => undefined);
    const followUp = vi.fn(async (_payload?: unknown) => undefined);
    const interaction = {
      channelId: "111111111111111111",
      replied: false,
      deferred: false,
      options: {
        get: (name: string) => options[name],
        getBoolean: (name: string) => options[name] === true,
      },
      member: {
        roles: { cache: new Map(roleNames.map((name, index) => [String(index), { name }])) },
      },
      guild: { roles: { cache: new Map() } },
      reply,
      followUp,
    };
    return { interaction: interaction as unknown as ChatInputCommandInteraction, reply, followUp };
  }

  it("lee opciones de texto, de canal y booleanas", () => {
    const { interaction } = fakeInteraction({
      ip: { value: "203.0.113.7" },
      canal: { value: {}, channel: { id: "111111111111111111" } },
      publico: true,
    });
    const port = toCommandInteraction(interaction);

    expect(port.getString("ip")).toBe("203.0.113.7");
    expect(port.getString("canal")).toBe("111111111111111111");
    expect(port.getBoolean("publico")).toBe(true);
    expect(port.getString("inexistente")).toBeNull();
  });

  it("lee los nombres de los roles", () => {
    const { interaction } = fakeInteraction({}, ["ServerManager", "LoCo+"]);
    expect(toCommandInteraction(interaction).roleNames()).toEqual(["ServerManager", "LoCo+"]);
  });

  it("responde con el flag efímero y los componentes de la vista", async () => {
    const { interaction, reply } = fakeInteraction();
    const port = toCommandInteraction(interaction);

    await port.reply({ view: view(), ephemeral: true });

    const payload = reply.mock.calls[0]?.[0] as { flags: number; components: unknown[] } | undefined;
    expect(payload).toBeDefined();
    expect(payload?.flags).toBe(MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral);
    expect(payload?.components).toHaveLength(1);
  });

  it("responde con texto si no hay vista y usa followUp si ya se había respondido", async () => {
    const { interaction, reply, followUp } = fakeInteraction();
    (interaction as { replied: boolean }).replied = true;
    const port = toCommandInteraction(interaction);

    await port.reply({ content: "hola", ephemeral: false });

    expect(reply).not.toHaveBeenCalled();
    expect(followUp).toHaveBeenCalledWith({ content: "hola" });
  });
});
