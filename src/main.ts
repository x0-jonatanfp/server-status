/**
 * Arranque del bot: cliente de Discord, comandos, presencia y senales.
 *
 * Aqui vive lo unico que habla con discord.js: el adaptador de canal (que
 * publica y edita el mensaje), el adaptador de interacciones y el registro de
 * los comandos por guild. El resto del proyecto (colectores, render, scheduler,
 * alertas y comandos) no sabe que existe Discord, y por eso se puede probar sin
 * conexion de gateway.
 */
import { pathToFileURL } from "node:url";

import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ActivityOptions,
  type Channel,
  type ChatInputCommandInteraction,
  type Interaction,
  type InteractionReplyOptions,
  type MessageCreateOptions,
  type MessageEditOptions,
  type PresenceData,
  type SendableChannels,
} from "discord.js";
import type winston from "winston";

import { AlertManager, type Alert } from "./alerts/alertManager.ts";
import { unbanIp } from "./collectors/fail2ban.ts";
import { collectAll, type StatusSnapshot } from "./collectors/index.ts";
import { commandPayloads, findCommand, type CommandContext } from "./commands/index.ts";
import type { CommandInteraction, CommandReply } from "./commands/types.ts";
import {
  ConfigError,
  loadConfig,
  type ActivityConfig,
  type ActivityTypeName,
} from "./config.ts";
import { createLogger } from "./logger.ts";
import { renderStatusView, toComponents } from "./render/statusView.ts";
import { Scheduler, type StatusPublisher } from "./scheduler.ts";
import { StateStore } from "./store.ts";
import { VERSION } from "./version.ts";

/** Tiempo maximo de apagado antes de rendirse (el plan pide menos de 5 s). */
export const SHUTDOWN_TIMEOUT_MS = 5000;

/** Codigo de Discord para "mensaje desconocido". */
export const UNKNOWN_MESSAGE_CODE = 10008;

const ACTIVITY_TYPES: Record<ActivityTypeName, ActivityType> = {
  Playing: ActivityType.Playing,
  Streaming: ActivityType.Streaming,
  Listening: ActivityType.Listening,
  Watching: ActivityType.Watching,
  Custom: ActivityType.Custom,
  Competing: ActivityType.Competing,
};

/**
 * Presencia del bot. Con `Custom`, `state` se muestra como estado personalizado
 * (es lo que permite el API de bots: un enlace libre en `url` solo se acepta con
 * `Streaming`, y solo de Twitch o YouTube).
 */
export function buildActivity(config: ActivityConfig): ActivityOptions {
  const activity: ActivityOptions = {
    name: config.name,
    type: ACTIVITY_TYPES[config.type],
  };
  if (config.state !== null) activity.state = config.state;
  if (config.type === "Streaming" && config.url !== null) activity.url = config.url;
  return activity;
}

// --- Adaptadores de Discord -------------------------------------------------

/** Canal con lo minimo que necesita el publisher (los tests inyectan un doble). */
export interface StatusChannel {
  send(payload: MessageCreateOptions): Promise<{ id: string }>;
  messages: {
    fetch(id: string): Promise<{ edit(payload: MessageEditOptions): Promise<unknown> }>;
  };
}

export interface ChannelResolver {
  resolve(channelId: string): Promise<StatusChannel | null>;
}

/** Canal con historial: es lo que hace falta para poder editar el mensaje. */
interface EditableChannel {
  messages: {
    fetch(id: string): Promise<{ edit(payload: MessageEditOptions): Promise<unknown> }>;
  };
}

function asStatusChannel(channel: Channel): StatusChannel | null {
  if (!channel.isSendable() || !("messages" in channel)) return null;
  const sendable = channel as SendableChannels & EditableChannel;
  return {
    send: async (payload) => {
      const message = await sendable.send(payload);
      return { id: message.id };
    },
    messages: {
      fetch: async (id) => {
        const message = await sendable.messages.fetch(id);
        return { edit: (payload) => message.edit(payload) };
      },
    },
  };
}

export function createChannelResolver(client: Client): ChannelResolver {
  return {
    async resolve(channelId) {
      const channel = await client.channels.fetch(channelId);
      return channel ? asStatusChannel(channel) : null;
    },
  };
}

/** `true` si el error es "el mensaje ya no existe" y hay que reenviarlo. */
export function isUnknownMessage(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === UNKNOWN_MESSAGE_CODE;
}

/**
 * Publisher de Discord: edita el mensaje guardado y solo reenvia si ya no
 * existe. Es lo que evita un mensaje nuevo cada cinco minutos.
 */
export function createDiscordPublisher(
  resolver: ChannelResolver,
  logger: Pick<winston.Logger, "debug" | "warn">,
): StatusPublisher {
  return {
    async publish(channelId, view, existingMessageId) {
      const channel = await resolver.resolve(channelId);
      if (!channel) {
        throw new Error(`el canal ${channelId} no existe o no admite mensajes`);
      }

      const { components, flags } = toComponents(view);

      if (existingMessageId !== null) {
        try {
          const message = await channel.messages.fetch(existingMessageId);
          await message.edit({ components, flags });
          return { messageId: existingMessageId, created: false };
        } catch (error) {
          if (!isUnknownMessage(error)) throw error;
          logger.debug(`el mensaje ${existingMessageId} ya no existe: se publica uno nuevo`);
        }
      }

      const sent = await channel.send({ components, flags });
      return { messageId: sent.id, created: true };
    },
  };
}

/** Texto de las alertas, para el canal de alertas. */
export function formatAlerts(alerts: Alert[]): string {
  return alerts
    .map((alert) => `${alert.severity === "critical" ? "🔴" : "🟠"} **${alert.title}**\n${alert.detail}`)
    .join("\n\n");
}

async function sendAlerts(
  resolver: ChannelResolver,
  alertChannelId: string | null,
  alerts: Alert[],
  logger: Pick<winston.Logger, "warn" | "error">,
): Promise<void> {
  if (alertChannelId === null) {
    logger.warn(`hay ${alerts.length} alerta(s) pero no hay ALERT_CHANNEL_ID configurado`);
    return;
  }
  const channel = await resolver.resolve(alertChannelId);
  if (!channel) {
    logger.error(`el canal de alertas ${alertChannelId} no existe o no admite mensajes`);
    return;
  }
  await channel.send({ content: formatAlerts(alerts) });
}

/** Convierte la interaccion de discord.js en el puerto que usan los comandos. */
export function toCommandInteraction(interaction: ChatInputCommandInteraction): CommandInteraction {
  return {
    channelId: interaction.channelId,
    getString(name) {
      const option = interaction.options.get(name);
      if (!option) return null;
      if (typeof option.value === "string") return option.value;
      return option.channel?.id ?? null;
    },
    getBoolean(name) {
      return interaction.options.getBoolean(name) ?? false;
    },
    roleNames() {
      const member = interaction.member;
      if (!member) return [];
      if (Array.isArray(member.roles)) {
        // Miembro sin cachear: solo llegan los ids.
        return member.roles
          .map((roleId) => interaction.guild?.roles.cache.get(roleId)?.name ?? "")
          .filter((name) => name !== "");
      }
      return [...member.roles.cache.values()].map((role) => role.name);
    },
    async reply(reply: CommandReply) {
      // El flag Ephemeral solo vale en respuestas de interaccion, no en un
      // mensaje normal; por eso el payload se tipa como InteractionReplyOptions.
      const ephemeral = reply.ephemeral === false ? 0 : MessageFlags.Ephemeral;

      let payload: InteractionReplyOptions;
      if (reply.view === undefined) {
        payload =
          ephemeral === 0
            ? { content: reply.content ?? "" }
            : { content: reply.content ?? "", flags: ephemeral };
      } else {
        // Los flags se suman: si no, el efimero borraria el de Components V2.
        const { components, flags } = toComponents(reply.view);
        payload = { components, flags: flags | ephemeral };
      }

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    },
  };
}

export async function handleInteraction(
  interaction: Interaction,
  context: CommandContext,
  logger: Pick<winston.Logger, "warn" | "error">,
): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  const command = findCommand(interaction.commandName);
  if (!command) {
    logger.warn(`comando desconocido: ${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(toCommandInteraction(interaction), context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`/${interaction.commandName} ha fallado: ${message}`);
    const payload: InteractionReplyOptions = {
      content: `❌ El comando ha fallado: ${message}`,
      flags: MessageFlags.Ephemeral,
    };
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch {
      // Si tampoco se puede responder, no hay nada mas que hacer.
    }
  }
}

/**
 * Registro de comandos. Se sincroniza por guild tras arrancar para que los
 * comandos aparezcan al momento; sin `GUILD_ID` cae a global, que puede tardar
 * hasta una hora en propagarse.
 */
export async function registerCommands(
  client: Client<true>,
  guildId: string | null,
  logger: Pick<winston.Logger, "info" | "warn">,
): Promise<void> {
  const payloads = commandPayloads();
  if (guildId !== null) {
    await client.application.commands.set(payloads, guildId);
    logger.info(`registrados ${payloads.length} comandos en el guild ${guildId}`);
    return;
  }
  await client.application.commands.set(payloads);
  logger.warn(
    `GUILD_ID no configurado: ${payloads.length} comandos registrados globalmente (pueden tardar en aparecer)`,
  );
}

// --- Apagado ----------------------------------------------------------------

export interface ShutdownOptions {
  stopScheduler: () => Promise<void>;
  destroyClient: () => Promise<void> | void;
  logger: Pick<winston.Logger, "info" | "warn" | "error">;
  timeoutMs?: number;
  exit?: (code: number) => void;
}

/**
 * Apagado limpio: para el bucle, cierra el cliente y sale. Si algo se atasca,
 * no espera mas de `timeoutMs` y sale con error en lugar de quedarse colgado.
 * Repetir la senal no vuelve a apagar nada.
 */
export function createShutdown(options: ShutdownOptions): (signal: string) => Promise<void> {
  let started = false;

  return async (signal: string) => {
    if (started) return;
    started = true;
    options.logger.info(`recibida la senal ${signal}: apagando`);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS);
      timer.unref();
    });

    const completed = await Promise.race([
      (async (): Promise<boolean> => {
        try {
          await options.stopScheduler();
          await options.destroyClient();
          return true;
        } catch (error) {
          options.logger.error(
            `error al apagar: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }
      })(),
      timeout,
    ]);

    if (timer !== undefined) clearTimeout(timer);

    if (completed) {
      options.logger.info("apagado completado");
      options.exit?.(0);
      return;
    }
    options.logger.error("el apagado no ha terminado a tiempo");
    options.exit?.(1);
  };
}

// --- Arranque ---------------------------------------------------------------

export async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Todavia no hay logger util: la configuracion es justo lo que ha fallado.
      console.error(`configuracion invalida: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const { app, inventory } = config;
  const logger = createLogger({ logFile: app.logFile, level: app.logLevel });
  logger.info(`arrancando ${app.botDisplayName} v${VERSION}`);

  const store = new StateStore({ path: app.statePath, logger });
  // El canal puede venir de /set_channel (persistido) o del .env.
  const channelId = (await store.getStatusChannelId()) ?? app.statusChannelId;

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const resolver = createChannelResolver(client);
  const startedAt = new Date();

  const alerts = new AlertManager({
    cooldownMinutes: inventory.alerts.cooldownMinutes,
    thresholds: inventory.alerts.thresholds,
  });

  // Las dos unicas funciones que necesitan los comandos y el bucle.
  const collect = () =>
    collectAll({
      diskMount: app.diskMount,
      httpTimeoutMs: app.httpTimeoutMs,
      websites: inventory.websites,
      serviceGroups: inventory.services,
      temperatureSensors: inventory.temperatures,
      fail2ban: { sudoPath: app.sudoPath, clientPath: app.fail2banClientPath },
      bot: () => ({
        pingMs: client.isReady() ? client.ws.ping : null,
        uptimeSeconds: process.uptime(),
      }),
    });

  const render = (snapshot: StatusSnapshot) =>
    renderStatusView(snapshot, {
      display: inventory.display,
      thresholds: inventory.alerts.thresholds,
      hostLabel: app.hostLabel,
      updateIntervalSeconds: app.updateIntervalSeconds,
      version: VERSION,
    });

  const scheduler = new Scheduler({
    updateIntervalSeconds: app.updateIntervalSeconds,
    channelId,
    collect,
    render,
    publisher: createDiscordPublisher(resolver, logger),
    store,
    logger,
    alerts,
    notifyAlerts: (pending) => sendAlerts(resolver, app.alertChannelId, pending, logger),
  });

  const context: CommandContext = {
    config: app,
    inventory,
    scheduler,
    store,
    collect,
    render,
    unban: (ip) =>
      unbanIp(ip, { sudoPath: app.sudoPath, clientPath: app.fail2banClientPath }),
    gatewayPingMs: () => (client.isReady() ? client.ws.ping : null),
    version: VERSION,
    startedAt,
    logger,
  };

  client.on(Events.Warn, (message: string) => logger.warn(`discord: ${message}`));
  client.on(Events.Error, (error: Error) => logger.error(`discord: ${error.message}`));
  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction, context, logger);
  });

  client.once(Events.ClientReady, (ready) => {
    void (async () => {
      logger.info(`conectado como ${ready.user.tag} (${ready.user.id})`);
      const presence: PresenceData = {
        status: "online",
        activities: [buildActivity(app.activity)],
      };
      ready.user.setPresence(presence);
      await registerCommands(ready, app.guildId, logger);
      scheduler.start();
    })();
  });

  const shutdown = createShutdown({
    stopScheduler: () => scheduler.stop(),
    destroyClient: () => {
      client.destroy();
    },
    logger,
    exit: (code) => process.exit(code),
  });
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await client.login(app.discordToken);
  } catch (error) {
    logger.error(
      `no se ha podido conectar con Discord: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

// Solo arranca cuando se ejecuta como programa, no al importarlo desde los tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
