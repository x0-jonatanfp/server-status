/**
 * El mensaje de estado ya renderizado.
 *
 * Son bloques de texto y el nivel global: nada de Discord ni de componentes. El
 * adaptador de Discord es quien lo convierte en Components V2, y por eso el
 * mismo render se puede publicar, responder en un comando o volcar a un log.
 */
import type { Level } from "../services/thresholds.ts";

export interface StatusView {
  /** Bloques de texto, ya en el orden del mensaje. */
  blocks: string[];
  level: Level;
  accentColor: number;
}
