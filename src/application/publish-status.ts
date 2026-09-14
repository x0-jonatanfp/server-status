/**
 * Caso de uso: publicar el estado, y el bucle que lo repite.
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
import type { Alert } from "../domain/entities/alert.ts";
import type { StatusSnapshot } from "../domain/entities/status-snapshot.ts";
import type { AlertNotifierPort } from "../domain/ports/alerts.ts";
import type { LoggerPort } from "../domain/ports/logger.ts";
import type { StateStorePort } from "../domain/ports/state-store.ts";
import type { StatusPublisherPort } from "../domain/ports/status-publisher.ts";
import type { StatusRendererPort } from "../domain/ports/status-renderer.ts";
import type { Level } from "../domain/services/thresholds.ts";
import type { AlertChecker } from "./check-alerts.ts";

export type RunReason = "startup" | "interval" | "manual";

export interface RunResult {
  reason: RunReason;
  at: Date;
  durationMs: number;
  level: Level | null;
  messageId: string | null;
  created: boolean;
  error: string | null;
}

export interface StatusLoopDeps {
  updateIntervalSeconds: number;
  /** Canales donde publicar. El mensaje de cada uno se edita por separado. */
  channelIds: string[];
  collect: () => Promise<StatusSnapshot>;
  renderer: StatusRendererPort;
  publisher: StatusPublisherPort;
  store: StateStorePort;
  logger: LoggerPort;
  /** Si se indica, cada ciclo evalua las alertas por umbral. */
  alertChecker?: AlertChecker;
  /** Envio de las alertas que pasan el cooldown. Sin esto no se envia nada. */
  notifier?: AlertNotifierPort;
  /** Se llama al terminar cada ciclo (exito o error). */
  onRun?: (result: RunResult) => void;
}

export class StatusLoop {
  private readonly deps: StatusLoopDeps;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<RunResult> | null = null;
  private lastRunResult: RunResult | null = null;
  private startedAt: Date | null = null;
  private stopped = true;
  private currentChannelIds: string[];

  constructor(deps: StatusLoopDeps) {
    this.deps = deps;
    this.currentChannelIds = [...deps.channelIds];
  }

  get channelIds(): readonly string[] {
    return this.currentChannelIds;
  }

  /** Primer canal, para mostrarlo en `/botstatus`. */
  get channelId(): string {
    return this.currentChannelIds[0] ?? "";
  }

  /**
   * `/set_channel`: deja ese canal como el unico destino. Es lo que espera quien
   * lo usa desde un guild concreto; para publicar en varios, la lista va en
   * `STATUS_CHANNEL_IDS`.
   */
  setChannel(channelId: string): void {
    this.currentChannelIds = [channelId];
    this.deps.logger.info(`canal de publicacion cambiado a ${channelId}`);
  }

  /** Arranca el bucle: un ciclo inmediato y luego uno por intervalo. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.startedAt = new Date();
    this.timer = setInterval(() => {
      void this.runOnce("interval");
    }, this.deps.updateIntervalSeconds * 1000);
    void this.runOnce("startup");
    this.deps.logger.info(
      `bucle arrancado: cada ${this.deps.updateIntervalSeconds} s en ${this.currentChannelIds.length} canal(es): ${this.currentChannelIds.join(", ")}`,
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
    this.deps.logger.info("bucle parado");
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
      const snapshot = await this.deps.collect();
      const view = this.deps.renderer.render(snapshot);
      result.level = view.level;

      // Un canal caido no puede impedir que se publique en los demas.
      const failures: string[] = [];
      for (const channelId of this.currentChannelIds) {
        try {
          const existingMessageId = await this.deps.store.getMessageId(channelId);
          const published = await this.deps.publisher.publish(channelId, view, existingMessageId);
          result.messageId = published.messageId;
          result.created = published.created;

          if (published.messageId !== existingMessageId) {
            await this.deps.store.setMessageId(channelId, published.messageId, snapshot.collectedAt);
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          failures.push(`${channelId}: ${detail}`);
          this.deps.logger.error(`no se ha podido publicar en el canal ${channelId}: ${detail}`);
        }
      }
      if (failures.length === this.currentChannelIds.length) {
        throw new Error(`no se ha podido publicar en ningun canal: ${failures.join("; ")}`);
      }

      await this.dispatchAlerts(snapshot);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      this.deps.logger.error(`ciclo ${reason} fallido: ${result.error}`);
    }

    result.durationMs = Date.now() - startedAt;
    this.lastRunResult = result;
    this.deps.onRun?.(result);
    return result;
  }

  /**
   * Evalua y envia alertas. Un fallo al enviarlas se registra pero no cambia el
   * resultado del ciclo: el mensaje de estado ya se ha publicado.
   */
  private async dispatchAlerts(snapshot: StatusSnapshot): Promise<void> {
    const { alertChecker, notifier } = this.deps;
    if (!alertChecker || !notifier) return;

    const pending: Alert[] = alertChecker.check(snapshot);
    if (pending.length === 0) return;

    try {
      await notifier.notify(pending);
      this.deps.logger.info(
        `enviadas ${pending.length} alerta(s): ${pending.map((alert) => alert.key).join(", ")}`,
      );
    } catch (error) {
      this.deps.logger.error(
        `no se han podido enviar las alertas: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
