/**
 * Punto de entrada del bot.
 *
 * Placeholder del andamiaje: la implementacion real se describe en PLAN.md.
 */
import { pathToFileURL } from "node:url";

export function main(): void {
  console.log("server-status: andamiaje listo, pendiente de implementar (ver PLAN.md)");
}

// Solo arranca cuando se ejecuta como programa, no al importarlo desde los tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
