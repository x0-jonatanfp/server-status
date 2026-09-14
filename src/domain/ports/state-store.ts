/**
 * Puerto de persistencia: canal de publicacion y mensaje vigente de cada canal.
 */

export interface ChannelState {
  /** Id del mensaje de estado vigente. `null` si aun no se ha publicado. */
  messageId: string | null;
  /** ISO de la ultima actualizacion correcta. */
  updatedAt: string | null;
}

export interface StateStorePort {
  /** Canal fijado con `/set_channel`, o `null` si nunca se ha fijado. */
  getStatusChannelId(): Promise<string | null>;
  setStatusChannelId(channelId: string | null): Promise<void>;
  getChannelState(channelId: string): Promise<ChannelState | null>;
  getMessageId(channelId: string): Promise<string | null>;
  setMessageId(channelId: string, messageId: string | null, updatedAt?: Date): Promise<void>;
}
