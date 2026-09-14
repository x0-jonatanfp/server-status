/**
 * Puerto de log.
 *
 * El dominio y la aplicacion no conocen winston: piden un logger con esta
 * forma. El logger real (winston) la cumple tal cual, asi que no hace falta
 * envolverlo.
 */
export interface LoggerPort {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}
