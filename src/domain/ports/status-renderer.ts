/**
 * Puerto de render: convierte el snapshot en el mensaje ya formateado.
 * El adaptador que lo implementa conoce Discord (Components V2); el caso de uso
 * solo ve bloques de texto.
 */
import type { StatusSnapshot } from "../entities/status-snapshot.ts";
import type { StatusView } from "../entities/status-view.ts";

export interface StatusRendererPort {
  render(snapshot: StatusSnapshot): StatusView;
}
