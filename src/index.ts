/**
 * nulldec-api-proxy — el Worker de Cloudflare que ES api.nulldec.com.
 *
 * Todo el tráfico de la API pasa por aquí: aplica los límites de tasa del
 * borde a las rutas restringidas y reenvía el resto (reescribiendo solo
 * `hostname` y `protocol`) al proyecto de Supabase.
 *
 * Esta fuente se reconstruyó el 2026-08-13 a partir del bundle desplegado
 * en Cloudflare (ver README.md de este repo para el porqué). Es una
 * traducción literal del bundle: sin los envoltorios del empaquetador
 * (`__defProp`, `__name`) y con los tipos de vuelta, pero sin cambiar
 * ninguna línea de lógica.
 */

export interface Env {
  SUPABASE_HOST: string;
  SUPABASE_ANON_KEY: string;
}

interface RestrictedPath {
  suffix: string;
  name: string;
  limit: number;
  windowSeconds: number;
}

const RESTRICTED_PATHS: RestrictedPath[] = [
  // Categoría A — crean recursos reales de pago, en nuestra cuenta o en
  // la del propio cliente. Las más estrictas de todas.
  { suffix: "/functions/v1/aws-tenant-deploy-decoy", name: "aws-tenant-deploy", limit: 5, windowSeconds: 3600 },
  { suffix: "/functions/v1/azure-tenant-deploy-decoy", name: "azure-tenant-deploy", limit: 5, windowSeconds: 3600 },
  { suffix: "/functions/v1/cli", name: "cli-gateway", limit: 30, windowSeconds: 3600 },
  { suffix: "/functions/v1/github-actions-issue-decoy", name: "gh-actions-issue", limit: 60, windowSeconds: 3600 },
  // Categoría C — exponen datos sensibles o permiten generar claves.
  { suffix: "/functions/v1/list-network-identifiers", name: "list-net-ids", limit: 3, windowSeconds: 60 },
  { suffix: "/functions/v1/generate-api-key", name: "gen-api-key", limit: 5, windowSeconds: 3600 },
  { suffix: "/functions/v1/manage-siem-keys", name: "manage-siem-keys", limit: 10, windowSeconds: 3600 },
  { suffix: "/functions/v1/verify-turnstile", name: "verify-turnstile", limit: 20, windowSeconds: 3600 },
  // Envía correo real (Resend) a sales@nulldec.com — sin este límite, la
  // única barrera contra flood del buzón de ventas sería Turnstile, que un
  // humano decidido puede seguir resolviendo a mano una y otra vez. Una
  // consulta legítima es una acción puntual, no repetida — 5/hora es
  // generoso para eso y corta cualquier intento de saturar el buzón.
  { suffix: "/functions/v1/contact-sales", name: "contact-sales", limit: 5, windowSeconds: 3600 },
  // Categoría B — puntos de entrada públicos, ya con secreto o firma,
  // pero conviene un techo aparte por si el secreto se filtrara.
  //
  // handle-aws-signal NO está aquí a propósito: quien la llama siempre
  // es la propia infraestructura de AWS (EventBridge), nunca el
  // atacante directamente — limitar por IP distinguiría "AWS" de "todo
  // lo demás", no "abuso" de "tráfico normal". La protege el secreto
  // compartido y la Capa 1, no un límite por IP aquí.
  { suffix: "/functions/v1/handle-network-signal", name: "handle-network-signal", limit: 120, windowSeconds: 60 },
  // Alta interacción — list-interactive-credentials es de las más
  // sensibles de todo el sistema: si el secreto global se filtrara,
  // esto expondría contraseñas en claro de todos los clientes de
  // golpe. Mismo criterio estricto que list-network-identifiers.
  { suffix: "/functions/v1/list-interactive-credentials", name: "list-interactive-creds", limit: 3, windowSeconds: 60 },
  { suffix: "/functions/v1/handle-interactive-signal", name: "handle-interactive-signal", limit: 60, windowSeconds: 60 },
];

function matchRestrictedPath(pathname: string): RestrictedPath | undefined {
  return RESTRICTED_PATHS.find((p) => pathname.endsWith(p.suffix));
}

async function checkAndIncrement(
  env: Env,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
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
    console.error("rate_limit_check falló:", res.status, await res.text());
    return true;
  }
  return await res.json();
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
      "access-control-allow-methods": "GET, POST, OPTIONS",
      ...extraHeaders,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown";
    const restricted = matchRestrictedPath(url.pathname);
    if (restricted && request.method !== "OPTIONS") {
      const key = `rl:${restricted.name}:${clientIp}`;
      const allowed = await checkAndIncrement(env, key, restricted.limit, restricted.windowSeconds);
      if (!allowed) {
        return jsonResponse(
          { error: "límite de peticiones excedido para esta operación" },
          429,
          { "retry-after": String(restricted.windowSeconds) },
        );
      }
    }

    const upstream = new URL(request.url);
    upstream.hostname = env.SUPABASE_HOST;
    upstream.protocol = "https:";
    const proxied = new Request(upstream.toString(), request);
    return fetch(proxied);
  },
};
