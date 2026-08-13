/**
 * nulldec-api-proxy — el Worker de Cloudflare que ES api.nulldec.com.
 *
 * Todo el tráfico de la API pasa por aquí: aplica los límites de tasa del
 * borde a las rutas restringidas y reenvía el resto (reescribiendo
 * `hostname`, `protocol` y, si aplica, el prefijo `/v1/`) al proyecto de
 * Supabase.
 *
 * Esta fuente se reconstruyó el 2026-08-13 a partir del bundle desplegado
 * en Cloudflare (ver README.md de este repo para el porqué). La tarea 6
 * verificó la reconstrucción byte a byte contra el bundle real; la tarea 7
 * cambió el emparejador de rutas restringidas (por sufijo → por método +
 * patrón). Esta tarea (8) añade la reescritura `/v1/*` → `/functions/v1/*`:
 * el Worker sigue sin conocer recursos ni verbos — es una única regla de
 * prefijo, no un router — para que no pueda desincronizarse de un contrato
 * que no conoce (spec §3). `/functions/v1/*` sigue funcionando exactamente
 * igual que antes de esta tarea.
 */

export interface Env {
  SUPABASE_HOST: string;
  SUPABASE_ANON_KEY: string;
}

export interface LimiteRuta {
  // Hoy TODAS las entradas declaran "*" a propósito. El campo existe porque el
  // spec §6 lo pide y porque la fase 2 lo necesitará de verdad (distinguir un
  // `GET /v1/decoys` de un `POST /v1/decoys` sobre el mismo patrón), pero
  // estrechar una entrada a un método concreto RELAJA el control que hoy está
  // vivo: el emparejador anterior a la fase 1 casaba por sufijo, sin mirar el
  // método, así que cualquier verbo caía en el cubo estricto. Poner
  // `method: "POST"` deja el resto de verbos fuera de ese cubo, y con el techo
  // por defecto pasan de 5/hora a 600/minuto sin que nadie lo note. Estrechar
  // cada entrada es una decisión de la fase 2, ruta a ruta y a propósito, no un
  // efecto colateral de reescribir el emparejador.
  method: string | "*";
  pattern: string; // admite segmentos ":param", p.ej. "/v1/decoys/:id/test"
  // El bucket (nombre del cubo del límite) se declara aparte del patrón y
  // NO se deriva de él a propósito: si algún día se renombra una ruta, el
  // límite no debe reiniciarse en silencio por haber cambiado de clave.
  // Estos 9 nombres son los que tienen contadores vivos en producción —
  // no cambiarlos aunque cambie `pattern`.
  bucket: string;
  limit: number;
  windowSeconds: number;
}

// Techo por defecto para lo no listado explícitamente abajo. Antes de esta
// tarea, lo que no aparecía en RESTRICTED_PATHS no tenía límite ninguno.
// Misma inversión que se hizo en la base de datos en la fase 0: acotado por
// defecto, abierto por decisión explícita (añadiendo una entrada más
// estricta a RESTRICTED_PATHS).
export const DEFAULT_BUCKET = "default";
export const DEFAULT_LIMIT = 600;
export const DEFAULT_WINDOW_SECONDS = 60;

/**
 * ...pero el techo NO es universal, y esa acotación es el arreglo, no un
 * descuido.
 *
 * Este Worker no es «la API»: es `api.nulldec.com`, y reenvía el proyecto de
 * Supabase ENTERO sin condición sobre el pathname. Por aquí pasan `/rest/v1`
 * (PostgREST) y `/auth/v1` (GoTrue) — las dos consolas apuntan ahí su cliente
 * de supabase-js— además de `/realtime/v1`, `/storage/v1`… Un techo aplicado a
 * todo el pathname metería un `rate_limit_check` secuencial (un viaje de ida y
 * vuelta MÁS una escritura en Postgres) delante de cada lectura de PostgREST de
 * la consola: justo lo contrario de la ronda de optimización del 2026-08-05.
 *
 * La restricción de la fase 1 es que ninguna ruta cambie de comportamiento. El
 * techo se aplica por tanto solo a la superficie de API (`/v1/…` y su forma
 * antigua `/functions/v1/…`), que es donde la fase 2 va a colgar los recursos
 * REST; todo lo demás se reenvía sin límite de borde, exactamente como antes de
 * la fase 1. Las 9 entradas explícitas de RESTRICTED_PATHS siguen aplicándose
 * igual, estén donde estén.
 *
 * Si `/rest/v1` merece un techo propio es una decisión aparte —con su propio
 * cubo, su propio límite y una medida del coste añadido por petición— y no se
 * toma aquí.
 */
export function tieneTechoPorDefecto(pathname: string): boolean {
  return pathname.startsWith("/v1/") || pathname.startsWith("/functions/v1/");
}

// Las NUEVE entradas declaran `method: "*"`. Ver el comentario de `method` en
// `LimiteRuta`: es la semántica idéntica a la desplegada antes de la fase 1
// (donde se casaba por sufijo, sin mirar el método), y estrechar cualquiera de
// ellas es trabajo de la fase 2, no de aquí.
export const RESTRICTED_PATHS: LimiteRuta[] = [
  // Categoría A — crean recursos reales de pago, en nuestra cuenta o en
  // la del propio cliente. Las más estrictas de todas.
  { method: "*", pattern: "/v1/aws-tenant-deploy-decoy", bucket: "aws-tenant-deploy", limit: 5, windowSeconds: 3600 },
  { method: "*", pattern: "/v1/azure-tenant-deploy-decoy", bucket: "azure-tenant-deploy", limit: 5, windowSeconds: 3600 },
  { method: "*", pattern: "/v1/github-actions-issue-decoy", bucket: "gh-actions-issue", limit: 60, windowSeconds: 3600 },
  // Categoría C — exponen datos sensibles o permiten generar claves.
  //
  // list-network-identifiers acepta GET y POST (verificado en el propio
  // handler): un método fijo la habría relajado incluso antes de saber lo
  // anterior.
  { method: "*", pattern: "/v1/list-network-identifiers", bucket: "list-net-ids", limit: 3, windowSeconds: 60 },
  { method: "*", pattern: "/v1/manage-siem-keys", bucket: "manage-siem-keys", limit: 10, windowSeconds: 3600 },
  { method: "*", pattern: "/v1/verify-turnstile", bucket: "verify-turnstile", limit: 20, windowSeconds: 3600 },
  // Envía correo real (Resend) a sales@nulldec.com — sin este límite, la
  // única barrera contra flood del buzón de ventas sería Turnstile, que un
  // humano decidido puede seguir resolviendo a mano una y otra vez. Una
  // consulta legítima es una acción puntual, no repetida — 5/hora es
  // generoso para eso y corta cualquier intento de saturar el buzón.
  { method: "*", pattern: "/v1/contact-sales", bucket: "contact-sales", limit: 5, windowSeconds: 3600 },
  // Categoría B — puntos de entrada públicos, ya con secreto o firma,
  // pero conviene un techo aparte por si el secreto se filtrara.
  //
  // handle-aws-signal no tiene límite ESPECÍFICO a propósito: quien la
  // llama siempre es la propia infraestructura de AWS (EventBridge),
  // nunca el atacante directamente — un cubo estricto por IP distinguiría
  // "AWS" de "todo lo demás", no "abuso" de "tráfico normal". Lo que la
  // protege de verdad es el secreto compartido y la Capa 1.
  // Sí cae, eso sí, bajo el techo por defecto (600/60 s por IP), porque
  // vive en `/v1/…`: no está exenta de límite, está exenta de uno propio.
  { method: "*", pattern: "/v1/handle-network-signal", bucket: "handle-network-signal", limit: 120, windowSeconds: 60 },
  // Alta interacción — list-interactive-credentials, que era la ruta más
  // sensible de todo el sistema (exponía en claro las credenciales de
  // todos los clientes si el secreto global se filtraba), se eliminó del
  // paso 3 de esta tarea: devuelve 404 desde la fase 0 y el 2026-08-11, así
  // que ya no hay nada que limitar ahí. Queda handle-interactive-signal,
  // sin ese riesgo de exposición masiva, con su propio límite.
  { method: "*", pattern: "/v1/handle-interactive-signal", bucket: "handle-interactive-signal", limit: 60, windowSeconds: 60 },
];

/**
 * Compara una ruta contra un patrón que admite segmentos ":param" (comodín
 * de un único segmento) y acepta las dos formas de prefijo que conviven
 * durante la migración: "/functions/v1/<fn>" (forma antigua, la que sigue
 * usando parte del tráfico existente) y "/v1/<fn>" (forma nueva). Todos los
 * patrones de RESTRICTED_PATHS se escriben en la forma "/v1/…"; esta función
 * normaliza el prefijo antes de comparar, así que casan ambas formas sin
 * duplicar entradas.
 */
export function pathMatchesPattern(pathname: string, pattern: string): boolean {
  const normalized = pathname.startsWith("/functions/v1/")
    ? "/v1/" + pathname.slice("/functions/v1/".length)
    : pathname;

  const pathSegments = normalized.split("/").filter(Boolean);
  const patternSegments = pattern.split("/").filter(Boolean);
  if (pathSegments.length !== patternSegments.length) return false;

  return patternSegments.every((seg, i) => seg.startsWith(":") || seg === pathSegments[i]);
}

export function matchRestrictedPath(method: string, pathname: string): LimiteRuta | undefined {
  return RESTRICTED_PATHS.find(
    (r) => (r.method === "*" || r.method === method) && pathMatchesPattern(pathname, r.pattern),
  );
}

/**
 * Reescribe el prefijo `/v1/` a `/functions/v1/` antes de reenviar. Es toda
 * la regla de enrutado que conoce el Worker: no sabe qué recursos ni verbos
 * hay detrás de cada ruta, solo reconoce un prefijo. Es justo lo que impide
 * que el Worker se desincronice de un contrato que no conoce (spec §3) — si
 * esta función alguna vez necesita saber de un recurso concreto, es la señal
 * de que esa lógica se está colando donde no debe.
 *
 * `/functions/v1/*` no se toca — sigue funcionando exactamente igual que
 * antes de esta regla, ambos prefijos conviven.
 *
 * Solo se reescribe cuando `/v1/` es el propio prefijo del pathname
 * (barra final incluida): `/v1` a secas (sin barra) no casa y pasa igual,
 * y un `/v1/` que aparezca más adelante en la ruta — p.ej.
 * `/functions/v1/algo/v1/otro` — tampoco, porque no es una sustitución
 * global sobre el string, es una regla de prefijo.
 */
export function reescribirPrefijoV1(pathname: string): string {
  if (!pathname.startsWith("/v1/")) return pathname;
  return "/functions/v1/" + pathname.slice("/v1/".length);
}

async function checkAndIncrement(
  env: Env,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const res = await fetch(`https://${env.SUPABASE_HOST}/rest/v1/rpc/rate_limit_check`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: env.SUPABASE_ANON_KEY,
        authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ p_key: key, p_limit: limit, p_window_seconds: windowSeconds }),
    });
    if (!res.ok) {
      // Falla en abierto a propósito: la autenticación real de estas rutas
      // es el secreto/JWT, no el límite de tasa, así que un hipo de la base
      // de datos no debe convertirse en un corte de tráfico legítimo.
      console.error("rate_limit_check falló:", res.status, await res.text());
      return true;
    }
    return await res.json();
  } catch (err) {
    // El mismo fallo en abierto, pero para el caso que el `!res.ok` no
    // cubre: `fetch` LANZA (DNS, TLS, corte de red contra Supabase) o el
    // cuerpo no es JSON parseable. Sin este catch, la promesa rechazaba y
    // el Worker devolvía un 1101/500 a una petición perfectamente legítima
    // — es decir, un fallo de la base de datos SÍ cortaba el tráfico, justo
    // lo que el `return true` de arriba existe para evitar. Es la misma
    // decisión, no una nueva.
    console.error("rate_limit_check lanzó:", err);
    return true;
  }
}

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Sin esto, cuando el límite se alcanza desde la consola (varias
      // de las rutas restringidas se llaman desde el navegador), el
      // navegador bloquea la respuesta por CORS antes de que el código
      // de la consola pueda mostrar el mensaje real — se vería como un
      // fallo de red genérico, no como "límite excedido".
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      // Sin exponer esta cabecera, la consola recibe el 429 pero no puede
      // leer `retry-after` (el CORS por defecto solo deja leer un puñado
      // de cabeceras "seguras", y esta no es una de ellas) — solo puede
      // decir "límite excedido" a secas, sin poder decir cuánto esperar.
      "access-control-expose-headers": "retry-after",
      ...extraHeaders,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown";

    if (request.method !== "OPTIONS") {
      const restricted = matchRestrictedPath(request.method, url.pathname);
      // Sin entrada explícita, solo hay límite si la ruta está en la
      // superficie de API — ver `tieneTechoPorDefecto`. Fuera de ella
      // (`/rest/v1`, `/auth/v1`, …) no se llama a la RPC siquiera: el coste
      // del límite es una escritura en Postgres por petición y no se paga
      // en el camino que la consola usa para leer.
      const aplica = restricted !== undefined || tieneTechoPorDefecto(url.pathname);

      if (aplica) {
        const bucket = restricted?.bucket ?? DEFAULT_BUCKET;
        const limit = restricted?.limit ?? DEFAULT_LIMIT;
        const windowSeconds = restricted?.windowSeconds ?? DEFAULT_WINDOW_SECONDS;

        const key = `rl:${bucket}:${clientIp}`;
        const allowed = await checkAndIncrement(env, key, limit, windowSeconds);
        if (!allowed) {
          return jsonResponse(
            { error: "límite de peticiones excedido para esta operación" },
            429,
            { "retry-after": String(windowSeconds) },
          );
        }
      }
    }

    const upstream = new URL(request.url);
    upstream.hostname = env.SUPABASE_HOST;
    upstream.protocol = "https:";
    // Orden decidido a propósito: el límite de tasa de arriba ya evaluó
    // `url.pathname` SIN reescribir, y da igual — `pathMatchesPattern`
    // normaliza `/functions/v1/` y `/v1/` como la misma ruta antes de
    // comparar (ver su comentario), así que este paso podría ir antes o
    // después del límite sin cambiar el resultado. Se reescribe aquí, al
    // construir la URL de destino, porque es donde ya se tocan `hostname`
    // y `protocol` — una sola parada para las mutaciones de la URL
    // saliente. `search` y `hash` no se tocan, así que sobreviven tal cual.
    upstream.pathname = reescribirPrefijoV1(upstream.pathname);
    const proxied = new Request(upstream.toString(), request);
    return fetch(proxied);
  },
};
