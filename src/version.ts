/**
 * Version del servicio, para el pie del mensaje de estado.
 * Sale de package.json para no tener dos numeros que se puedan desincronizar.
 */
import { version } from "../package.json";

export const VERSION: string = version;
