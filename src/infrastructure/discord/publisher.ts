/**
 * Adaptadores de publicacion y de alertas.
 *
 * Un canal de Discord se reduce a la interfaz minima que necesita el caso de uso
 * (enviar y editar), asi que los tests del bucle inyectan un doble sin cliente.
 *
 * "Editar y solo reenviar si ya no existe" es el comportamiento que evita el bug
 * del bot antiguo, que publicaba un mensaje nuevo cada cinco minutos y con el se
 * perdian reacciones e hilos.
 */
import type {
  Channel,
  Client,
  MessageCreateOptions,
  MessageEditOptions,
  SendableChannels,
} from "discord.js";

import type { Alert } from "../../domain/entities/alert.ts";
import type { StatusView } from "../../domain/entities/status-view.ts";
import type { AlertNotifierPort } from "../../domain/ports/alerts.ts";
import type { LoggerPort } from "../../domain/ports/logger.ts";
import type { PublishResult, StatusPublisherPort } from "../../domain/ports/status-publisher.ts";
import { toComponents } from "./status-view.ts";

/** Codigo de Discord para "mensaje desconocido". */
export const UNKNOWN_MESSAGE_CODE = 10008;

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
 * existe.
 */
export function createDiscordPublisher(
  resolver: ChannelResolver,
  logger: Pick<LoggerPort, "debug" | "warn">,
): StatusPublisherPort {
  return {
    async publish(
      channelId: string,
      view: StatusView,
      existingMessageId: string | null,
    ): Promise<PublishResult> {
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
    .map(
      (alert) =>
        `${alert.severity === "critical" ? "🔴" : "🟠"} **${alert.title}**\n${alert.detail}`,
    )
    .join("\n\n");
}

/** Notificador: manda las alertas al canal configurado, o avisa de que no lo hay. */
export function createDiscordAlertNotifier(options: {
  resolver: ChannelResolver;
  alertChannelId: string | null;
  logger: Pick<LoggerPort, "warn" | "error">;
}): AlertNotifierPort {
  return {
    async notify(alerts: Alert[]): Promise<void> {
      // Sin ALERT_CHANNEL_ID las alertas se quedan en el log del servicio, que
      // es el modo elegido para no ensuciar Discord. Se registran con su
      // severidad para poder filtrarlas.
      if (options.alertChannelId === null) {
        for (const alert of alerts) {
          const line = `${alert.title} — ${alert.detail}`;
          if (alert.severity === "critical") options.logger.error(line);
          else options.logger.warn(line);
        }
        return;
      }
      const channel = await options.resolver.resolve(options.alertChannelId);
      if (!channel) {
        options.logger.error(
          `el canal de alertas ${options.alertChannelId} no existe o no admite mensajes`,
        );
        return;
      }
      await channel.send({ content: formatAlerts(alerts) });
    },
  };
}
