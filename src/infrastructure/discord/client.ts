/**
 * Adaptador del cliente de Discord: lo unico que habla con discord.js.
 *
 * Incluye la presencia del bot, el registro de comandos por guild, la
 * traduccion de una interaccion al puerto que usan los comandos y el apagado
 * limpio. El resto del proyecto no sabe que existe Discord, y por eso se puede
 * probar sin conexion de gateway.
 */
import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ActivityOptions,
  type ChatInputCommandInteraction,
  type Interaction,
  type InteractionReplyOptions,
  type PresenceData,
} from "discord.js";

import type { BotStatus } from "../../domain/entities/status-snapshot.ts";
import type { BotStatusPort } from "../../domain/ports/bot-status.ts";
import type { LoggerPort } from "../../domain/ports/logger.ts";
import type { ActivityConfig, ActivityTypeName, AppConfig } from "../config/env.ts";
import { commandPayloads, findCommand, type CommandContext } from "./commands/index.ts";
import type { CommandInteraction, CommandReply } from "./commands/types.ts";
import { toComponents } from "./status-view.ts";

/** Tiempo maximo de apagado antes de rendirse (el plan pide menos de 5 s). */
export const SHUTDOWN_TIMEOUT_MS = 5000;

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

export function createDiscordClient(): Client {
  // GatewayIntentBits.Guilds es lo unico que necesita un bot de 6 comandos.
  return new Client({ intents: [GatewayIntentBits.Guilds] });
}

/**
 * Adaptador del puerto de estado del bot: latencia del gateway y uptime del
 * proceso. La latencia es `-1` antes de la primera conexion, asi que se
 * normaliza a `null`.
 */
export function createBotStatusPort(client: Client): BotStatusPort {
  return {
    status(): BotStatus {
      return {
        pingMs: client.isReady() ? Math.max(0, client.ws.ping) : null,
        uptimeSeconds: process.uptime(),
      };
    },
  };
}

/** Convierte la interaccion de discord.js en el puerto que usan los comandos. */
export function toCommandInteraction(
  interaction: ChatInputCommandInteraction,
): CommandInteraction {
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
  logger: Pick<LoggerPort, "warn" | "error">,
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
  logger: Pick<LoggerPort, "info" | "warn">,
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
  stopLoop: () => Promise<void>;
  destroyClient: () => Promise<void> | void;
  logger: Pick<LoggerPort, "info" | "warn" | "error">;
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
          await options.stopLoop();
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

/**
 * Engancha la presencia del bot al ciclo de vida del gateway y devuelve el
 * refresco para reenviarla desde fuera.
 *
 * Un estado personalizado se pierde a lo largo de las horas: cuando la sesion
 * del gateway se rehace (reanudacion o re-identificacion), Discord limpia la
 * presencia y el bot se queda sin el emoji ni el nombre del estado hasta el
 * siguiente arranque. Por eso se reenvia en cada shard listo y en cada
 * reanudacion, y el bucle del estado la repite en cada ciclo (por si Discord la
 * limpia por su cuenta). Es un solo camino de envio, sin temporizador propio.
 */
export function attachPresence(
  client: Client,
  activity: ActivityOptions,
  logger: Pick<LoggerPort, "warn">,
): () => void {
  const presence: PresenceData = {
    status: "online",
    activities: [activity],
  };

  const refresh = (): void => {
    if (!client.isReady()) return;
    try {
      client.user?.setPresence(presence);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`no se ha podido enviar la presencia: ${message}`);
    }
  };

  client.on(Events.ShardReady, refresh);
  client.on(Events.ShardResume, refresh);
  return refresh;
}

/**
 * Conecta el cliente y fija los comandos al estar listo. La presencia va aparte,
 * con `attachPresence`: tiene que reenviarse al reconectar, no solo al arrancar.
 */
export async function connect(options: {
  client: Client;
  config: AppConfig;
  logger: LoggerPort;
  onReady: (client: Client<true>) => void | Promise<void>;
}): Promise<void> {
  const { client, config, logger } = options;

  client.on(Events.Warn, (message: string) => logger.warn(`discord: ${message}`));
  client.on(Events.Error, (error: Error) => logger.error(`discord: ${error.message}`));

  client.once(Events.ClientReady, (ready) => {
    void (async () => {
      logger.info(`conectado como ${ready.user.tag} (${ready.user.id})`);
      await options.onReady(ready);
    })();
  });

  await client.login(config.discordToken);
}
