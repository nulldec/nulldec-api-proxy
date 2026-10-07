import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // El brief de esta tarea pide `src/match_test.ts` (sufijo `_test.ts`,
    // no el `.test.ts` que vitest busca por defecto) — se amplía el patrón
    // en vez de renombrar el fichero.
    // `registry/` es el Worker aparte de registry.nulldec.com (10 §6.3); sus
    // pruebas corren en la misma pasada.
    include: ["src/**/*_test.ts", "src/**/*.test.ts", "registry/src/**/*.test.ts"],
  },
});
