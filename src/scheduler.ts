/**
 * Bucle de actualizacion.
 *
 * Un ciclo recolecta el snapshot, lo renderiza, lo publica (editando el mensaje
 * existente) y persiste el id resultante. El intervalo sale siempre de la
 * configuracion (`UPDATE_INTERVAL`), no de una constante: el bug del bot antiguo
 * era justamente que `BOT_UPDATE_INTERVAL` no cambiaba nada.
 *
 * Dos garantias pensadas para Discord:
 * - los ciclos no se solapan: si uno sigue en marcha, el siguiente reutiliza su
 *   resultado en lugar de lanzar una segunda edicion sobre el mismo mensaje.
 * - un fallo de recoleccion o de publicacion se registra y se devuelve en el
 *   resultado; no para el bucle ni tumba el proceso.
 */
import type winston from "winston";

import type { AlertManager, Alert } from "./alerts/alertManager.ts";
import type { StatusSnapshot } from "./collectors/index.ts";
import type { Level } from "./render/thresholds.ts";
import type { StatusView } from "./render/statusView.ts";
import type { StateStore } from "./store.ts";

export type RunReason = "startup" | "interval" | "manual";

export interface PublishResult {
  messageId: string;
  /** `true` si hubo que crear el mensaje porque ya no existia. */
  created: boolean;
}

/** Puerto hacia Discord: el scheduler no sabe nada de discord.js. */
export interface StatusPublisher {
  publish(channelId: string, view: StatusView, existingMessageId: string | null): Promise<PublishResult>;
}

export interface RunResult {
  reason: RunReason;
  at: Date;
  durationMs: number;
  level: Level | null;
  messageId: string | null;
  created: boolean;
  error: string | null;
}

export interface SchedulerOptions {
  updateIntervalSeconds: number;
  channelId: string;
  collect: () => Promise<StatusSnapshot>;
  render: (snapshot: StatusSnapshot) => StatusView;
  publisher: StatusPublisher;
  store: StateStore;
  logger: Pick<winston.Logger, "info" | "warn" | "error" | "debug">;
  /** Si se indica, cada ciclo evalua las alertas por umbral. */
  alerts?: AlertManager;
  /** Envio de las alertas que pasan el cooldown. Sin esto no se envia nada. */
  notifyAlerts?: (alerts: Alert[]) => Promise<void>;
  /** Se llama al terminar cada ciclo (exito o error). */
  onRun?: (result: RunResult) => void;
}

export class Scheduler {
  private readonly options: SchedulerOptions;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<RunResult> | null = null;
  private lastRunResult: RunResult | null = null;
  private startedAt: Date | null = null;
  private stopped = true;
  private currentChannelId: string;

  constructor(options: SchedulerOptions) {
    this.options = options;
    this.currentChannelId = options.channelId;
  }

  get channelId(): string {
    return this.currentChannelId;
  }

  /** Cambia el canal de publicacion (`/set_channel`). El siguiente ciclo crea o edita alli. */
  setChannel(channelId: string): void {
    this.currentChannelId = channelId;
    this.options.logger.info(`canal de publicacion cambiado a ${channelId}`);
  }

  /** Arranca el bucle: un ciclo inmediato y luego uno por intervalo. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.startedAt = new Date();
    this.timer = setInterval(() => {
      void this.runOnce("interval");
    }, this.options.updateIntervalSeconds * 1000);
    void this.runOnce("startup");
    this.options.logger.info(
      `bucle arrancado: cada ${this.options.updateIntervalSeconds} s en el canal ${this.currentChannelId}`,
    );
  }

  /** Para el bucle y espera al ciclo en curso. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.current) {
      await this.current.catch(() => undefined);
    }
    this.options.logger.info("bucle parado");
  }

  get lastRun(): RunResult | null {
    return this.lastRunResult;
  }

  get startedAtDate(): Date | null {
    return this.startedAt;
  }

  get isRunning(): boolean {
    return this.current !== null;
  }

  /**
   * Ejecuta un ciclo. Si ya hay uno en marcha devuelve su promesa en lugar de
   * lanzar otro: dos ediciones simultaneas sobre el mismo mensaje solo generan
   * errores de Discord y mensajes duplicados.
   */
  async runOnce(reason: RunReason): Promise<RunResult> {
    if (this.current) return this.current;
    const execution = this.execute(reason);
    this.current = execution;
    try {
      return await execution;
    } finally {
      this.current = null;
    }
  }

  private async execute(reason: RunReason): Promise<RunResult> {
    const startedAt = Date.now();
    const result: RunResult = {
      reason,
      at: new Date(startedAt),
      durationMs: 0,
      level: null,
      messageId: null,
      created: false,
      error: null,
    };

    try {
      const snapshot = await this.options.collect();
      const view = this.options.render(snapshot);
      result.level = view.level;

      const existingMessageId = await this.options.store.getMessageId(this.currentChannelId);
      const published = await this.options.publisher.publish(
        this.currentChannelId,
        view,
        existingMessageId,
      );
      result.messageId = published.messageId;
      result.created = published.created;

      if (published.messageId !== existingMessageId) {
        await this.options.store.setMessageId(
          this.currentChannelId,
          published.messageId,
          snapshot.collectedAt,
        );
      }

      await this.dispatchAlerts(snapshot);
      this.options.logger.debug(
        `ciclo ${reason}: ${published.created ? "mensaje nuevo" : "mensaje editado"} ${published.messageId}`,
      );
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      this.options.logger.error(`ciclo ${reason} fallido: ${result.error}`);
    }

    result.durationMs = Date.now() - startedAt;
    this.lastRunResult = result;
    this.options.onRun?.(result);
    return result;
  }

  /**
   * Evalua y envia alertas. Un fallo al enviarlas se registra pero no cambia el
   * resultado del ciclo: el mensaje de estado ya se ha publicado.
   */
  private async dispatchAlerts(snapshot: StatusSnapshot): Promise<void> {
    const { alerts, notifyAlerts } = this.options;
    if (!alerts || !notifyAlerts) return;

    const pending = alerts.evaluate(snapshot);
    if (pending.length === 0) return;

    try {
      await notifyAlerts(pending);
      this.options.logger.info(`enviadas ${pending.length} alerta(s): ${pending.map((alert) => alert.key).join(", ")}`);
    } catch (error) {
      this.options.logger.error(
        `no se han podido enviar las alertas: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
