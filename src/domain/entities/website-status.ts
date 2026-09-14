/**
 * Resultado de comprobar una web del inventario.
 */
export interface WebsiteStatus {
  label: string;
  url: string;
  up: boolean;
  /** Codigo HTTP de la respuesta final, `null` si ni siquiera hubo respuesta. */
  statusCode: number | null;
  /** Milisegundos hasta la primera respuesta, `null` si fallo. */
  latencyMs: number | null;
  error: string | null;
}
