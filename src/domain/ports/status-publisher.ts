/**
 * Puerto de publicacion del mensaje de estado.
 *
 * "Editar y solo reenviar si ya no existe" es parte del contrato: el adaptador
 * recibe el id del mensaje vigente y responde cual queda publicado.
 */
import type { StatusView } from "../entities/status-view.ts";

export interface PublishResult {
  messageId: string;
  /** `true` si hubo que crear el mensaje porque ya no existia. */
  created: boolean;
}

export interface StatusPublisherPort {
  publish(
    channelId: string,
    view: StatusView,
    existingMessageId: string | null,
  ): Promise<PublishResult>;
}
