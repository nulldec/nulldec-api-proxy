// registry/src/index.ts
//
// Worker `nulldec-registry`: registry.nulldec.com, el registro de SOLO LECTURA
// de NullDec Node (10-nulldec-node.md §6.3). Delante de GHCR, con el flujo de
// autenticación por token del protocolo de distribución
// (https://distribution.github.io/distribution/spec/auth/token/):
//
//   GET /v2/                         401 + WWW-Authenticate sin token; 200 {} con uno válido
//   GET /token?service=…&scope=…     Basic nodo:<ndo_> → el backend decide → JWT HS256 de 300 s
//   GET|HEAD /v2/<repo>/manifests/<sha256:…>   solo digests concedidos; proxy a GHCR
//   GET|HEAD /v2/<repo>/blobs/<sha256:…>       redirección de GHCR tal cual, o el cuerpo en streaming
//
// Lo que nunca sale de aquí: la `ndo_` del nodo (ni en respuestas ni en
// registros; el JWT lleva solo su prefijo) y el token de GHCR (vive en los
// secretos del Worker y en memoria del aislado).
//
// Es un Worker aparte de nulldec-api-proxy a propósito: no comparte ni
// wrangler.toml ni despliegue con el Worker que está delante de toda la API.

export interface Env {
  /** Secreto HMAC de los JWT. Sin él (o corto), el Worker falla en cerrado. */
  REGISTRY_JWT_SECRET?: string;
  /** Usuario y token de lectura de GHCR (read:packages). */
  GHCR_USER?: string;
  GHCR_TOKEN?: string;
  /** Base de la API de NullDec. Por defecto https://api.nulldec.com. */
  NULLDEC_API?: string;
}

export const HOST = "registry.nulldec.com";
export const REALM = `https://${HOST}/token`;
export const TTL_S = 300;
export const GHCR = "https://ghcr.io";
export const GHCR_ORG = "nulldec";

/** Los únicos repos que existen para este registro (IMAGENES_DE_PERFIL del backend). */
export const REPOS: readonly string[] = [
  "nodo-agente",
  "nodo-canary",
  "nodo-rele",
  "deception-engine",
  "interactive-orchestrator",
  "hassh-sniffer",
];

/** Misma forma que `generateNodeKey` / `extractNodePrefix` del backend (_shared/apikey.ts). */
const CLAVE_NODO = /^ndo_([0-9a-f]{8})_[0-9a-f]{48}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
/**
 * La única etiqueta que se resuelve: la que cosign usa para guardar la firma,
 * la atestación o el SBOM de una imagen (`sha256-<hex>.sig`). Solo de un
 * digest concedido: sin ella el nodo no puede verificar lo que descarga.
 */
const ETIQUETA_DE_FIRMA = /^sha256-([0-9a-f]{64})\.(sig|att|sbom)$/;
const RUTA = /^\/v2\/([a-z0-9-]+)\/(manifests|blobs)\/([^/]+)$/;
const ACCEPT_POR_DEFECTO = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const TIEMPO_BACKEND_MS = 10_000;
const MARGEN_GHCR_MS = 30_000;

// ── Respuestas ──

function cabecerasBase(extra: Record<string, string> = {}): Headers {
  const h = new Headers(extra);
  h.set("Docker-Distribution-API-Version", "registry/2.0");
  h.set("Cache-Control", "no-store");
  return h;
}

function json(status: number, cuerpo: unknown, extra: Record<string, string> = {}): Response {
  const h = cabecerasBase(extra);
  h.set("Content-Type", "application/json");
  return new Response(JSON.stringify(cuerpo), { status, headers: h });
}

function error(status: number, code: string, message: string, extra: Record<string, string> = {}): Response {
  return json(status, { errors: [{ code, message }] }, extra);
}

/** 401 con el reto Bearer. Con `scope` en las rutas de repo, para que el cliente pida el token justo. */
function reto(scope?: string, err?: "invalid_token" | "insufficient_scope"): Response {
  let v = `Bearer realm="${REALM}",service="${HOST}"`;
  if (scope) v += `,scope="${scope}"`;
  if (err) v += `,error="${err}"`;
  return error(401, "UNAUTHORIZED", "authentication required", { "WWW-Authenticate": v });
}

// ── base64url y JWT HS256 ──

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function desdeB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

let claveHmac: { secreto: string; clave: Promise<CryptoKey> } | null = null;
function hmac(secreto: string): Promise<CryptoKey> {
  if (claveHmac?.secreto !== secreto) {
    claveHmac = {
      secreto,
      clave: crypto.subtle.importKey("raw", enc.encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
    };
  }
  return claveHmac.clave;
}

/** Un secreto de menos de 32 caracteres no firma nada: fallo en cerrado. */
function secretoJwt(env: Env): string | null {
  const s = env.REGISTRY_JWT_SECRET;
  return typeof s === "string" && s.length >= 32 ? s : null;
}

export interface Acceso {
  type: "repository";
  name: string;
  actions: ["pull"];
}

export interface Reclamos {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  access: Acceso[];
  /** `repo@sha256:…`, solo de los repos de `access`. */
  digests: string[];
}

export async function firmarJwt(reclamos: Reclamos, secreto: string): Promise<string> {
  const cab = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const cue = b64url(enc.encode(JSON.stringify(reclamos)));
  const firma = new Uint8Array(await crypto.subtle.sign("HMAC", await hmac(secreto), enc.encode(`${cab}.${cue}`)));
  return `${cab}.${cue}.${b64url(firma)}`;
}

/** El JWT si es nuestro, está bien firmado y vigente; null en cualquier otro caso. */
export async function verificarJwt(token: string, secreto: string, ahora = Date.now()): Promise<Reclamos | null> {
  const partes = token.split(".");
  if (partes.length !== 3) return null;
  const [cab, cue, fir] = partes;
  const firma = desdeB64url(fir);
  const cabBytes = desdeB64url(cab);
  const cueBytes = desdeB64url(cue);
  if (!firma || !cabBytes || !cueBytes) return null;
  // crypto.subtle.verify compara en tiempo constante.
  if (!(await crypto.subtle.verify("HMAC", await hmac(secreto), firma, enc.encode(`${cab}.${cue}`)))) return null;
  try {
    const h = JSON.parse(dec.decode(cabBytes)) as { alg?: unknown };
    if (h.alg !== "HS256") return null;
    const r = JSON.parse(dec.decode(cueBytes)) as Reclamos;
    const s = Math.floor(ahora / 1000);
    if (r.iss !== HOST || r.aud !== HOST) return null;
    if (typeof r.exp !== "number" || r.exp <= s) return null;
    if (typeof r.nbf !== "number" || r.nbf > s + 30) return null;
    if (!Array.isArray(r.access) || !Array.isArray(r.digests)) return null;
    return r;
  } catch {
    return null;
  }
}

// ── /token ──

/** Repos pedidos con acción `pull` en los `scope=repository:<repo>:<acciones>`. */
export function reposPedidos(params: URLSearchParams): string[] {
  const out = new Set<string>();
  for (const scopes of params.getAll("scope")) {
    // Un mismo parámetro puede llevar varios scopes separados por espacio.
    for (const scope of scopes.split(" ")) {
      const m = /^repository:([a-z0-9-]+):([a-z,*]+)$/.exec(scope);
      if (m && m[2].split(",").includes("pull") && REPOS.includes(m[1])) out.add(m[1]);
    }
  }
  return [...out].sort();
}

/** La contraseña de `Authorization: Basic …`, o null. El usuario da igual. */
function claveDeBasic(req: Request): string | null {
  const a = req.headers.get("Authorization") ?? "";
  const m = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(a);
  if (!m) return null;
  let claro: string;
  try {
    claro = atob(m[1]);
  } catch {
    return null;
  }
  const i = claro.indexOf(":");
  return i < 0 ? null : claro.slice(i + 1);
}

interface Concesion {
  repos: string[];
  digests: string[];
  expira_s?: number;
}

function esConcesion(v: unknown): v is Concesion {
  const c = v as Partial<Concesion> | null;
  return !!c && Array.isArray(c.repos) && c.repos.every((r) => typeof r === "string") &&
    Array.isArray(c.digests) && c.digests.every((d) => typeof d === "string");
}

const NO_AUTORIZADO_BASIC = { "WWW-Authenticate": `Basic realm="${HOST}"` };

async function token(req: Request, env: Env, url: URL): Promise<Response> {
  const secreto = secretoJwt(env);
  if (!secreto) {
    console.error("registry: REGISTRY_JWT_SECRET ausente o corto");
    return error(503, "UNAVAILABLE", "registry not configured");
  }
  const servicio = url.searchParams.get("service");
  if (servicio !== null && servicio !== HOST) return error(400, "UNSUPPORTED", "unknown service");

  const clave = claveDeBasic(req);
  const m = clave ? CLAVE_NODO.exec(clave) : null;
  if (!clave || !m) return error(401, "UNAUTHORIZED", "invalid credentials", NO_AUTORIZADO_BASIC);
  const prefijo = m[1];

  let r: Response;
  try {
    const base = (env.NULLDEC_API || "https://api.nulldec.com").replace(/\/+$/, "");
    // La cabecera que lee `authenticateNodoKey` (_shared/nodo-auth.ts) es `x-api-key`.
    r = await fetch(`${base}/functions/v1/nodos/registro/token`, {
      method: "POST",
      headers: { "x-api-key": clave, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(TIEMPO_BACKEND_MS),
    });
  } catch {
    console.error(`registry: backend inalcanzable (nodo ${prefijo})`);
    return error(503, "UNAVAILABLE", "upstream unavailable");
  }

  if (r.status === 401 || r.status === 404 || r.status === 410) {
    return error(401, "UNAUTHORIZED", "invalid credentials", NO_AUTORIZADO_BASIC);
  }
  if (r.status === 429) {
    const extra: Record<string, string> = {};
    const ra = r.headers.get("Retry-After");
    if (ra && /^\d+$/.test(ra)) extra["Retry-After"] = ra;
    return error(429, "TOOMANYREQUESTS", "too many requests", extra);
  }
  if (r.status !== 200) {
    console.error(`registry: backend respondió ${r.status} (nodo ${prefijo})`);
    return error(503, "UNAVAILABLE", "upstream unavailable");
  }
  let c: unknown;
  try {
    c = await r.json();
  } catch {
    c = null;
  }
  if (!esConcesion(c)) {
    console.error(`registry: concesión mal formada (nodo ${prefijo})`);
    return error(503, "UNAVAILABLE", "upstream unavailable");
  }

  const concedidos = new Set(c.repos.filter((x) => REPOS.includes(x)));
  const access: Acceso[] = reposPedidos(url.searchParams)
    .filter((repo) => concedidos.has(repo))
    .map((name) => ({ type: "repository", name, actions: ["pull"] }));
  const nombres = new Set(access.map((a) => a.name));
  const digests = c.digests.filter((d) => {
    const i = d.indexOf("@");
    return i > 0 && nombres.has(d.slice(0, i)) && DIGEST.test(d.slice(i + 1));
  });

  const ttl = typeof c.expira_s === "number" && c.expira_s > 0 ? Math.min(TTL_S, Math.floor(c.expira_s)) : TTL_S;
  const ahora = Date.now();
  const iat = Math.floor(ahora / 1000);
  const jwt = await firmarJwt(
    { iss: HOST, aud: HOST, sub: prefijo, iat, nbf: iat, exp: iat + ttl, jti: crypto.randomUUID(), access, digests },
    secreto,
  );
  return json(200, { token: jwt, access_token: jwt, expires_in: ttl, issued_at: new Date(iat * 1000).toISOString() });
}

// ── GHCR ──

const cacheGhcr = new Map<string, { token: string; hasta: number }>();

/** Solo para las pruebas: vacía la caché del aislado. */
export function reiniciarCacheGhcr(): void {
  cacheGhcr.clear();
}

async function tokenGhcr(env: Env, repo: string, forzar = false): Promise<string | null> {
  const ahora = Date.now();
  const c = cacheGhcr.get(repo);
  if (!forzar && c && c.hasta > ahora) return c.token;
  if (!env.GHCR_USER || !env.GHCR_TOKEN) {
    console.error("registry: faltan GHCR_USER o GHCR_TOKEN");
    return null;
  }
  const scope = `repository:${GHCR_ORG}/${repo}:pull`;
  let r: Response;
  try {
    r = await fetch(`${GHCR}/token?service=ghcr.io&scope=${encodeURIComponent(scope)}`, {
      headers: { Authorization: `Basic ${btoa(`${env.GHCR_USER}:${env.GHCR_TOKEN}`)}` },
      signal: AbortSignal.timeout(TIEMPO_BACKEND_MS),
    });
  } catch {
    console.error("registry: GHCR /token inalcanzable");
    return null;
  }
  if (!r.ok) {
    console.error(`registry: GHCR /token respondió ${r.status}`);
    return null;
  }
  const b = (await r.json().catch(() => null)) as { token?: unknown; access_token?: unknown; expires_in?: unknown } | null;
  const t = typeof b?.token === "string" ? b.token : typeof b?.access_token === "string" ? b.access_token : null;
  if (!t) return null;
  const vida = typeof b?.expires_in === "number" && b.expires_in > 0 ? b.expires_in : TTL_S;
  cacheGhcr.set(repo, { token: t, hasta: ahora + Math.max(0, vida * 1000 - MARGEN_GHCR_MS) });
  return t;
}

/** Petición a GHCR con su token; un 401 renueva el token una vez (revocado o caducado antes de tiempo). */
async function aGhcr(env: Env, repo: string, ruta: string, init: RequestInit): Promise<Response | null> {
  for (const forzar of [false, true]) {
    const t = await tokenGhcr(env, repo, forzar);
    if (!t) return null;
    const h = new Headers(init.headers);
    h.set("Authorization", `Bearer ${t}`);
    let r: Response;
    try {
      r = await fetch(`${GHCR}/v2/${GHCR_ORG}/${repo}/${ruta}`, { ...init, headers: h });
    } catch {
      console.error(`registry: GHCR inalcanzable (${repo})`);
      return null;
    }
    if (r.status !== 401) return r;
    cacheGhcr.delete(repo);
  }
  console.error(`registry: GHCR rechaza el token de lectura (${repo})`);
  return null;
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return "sha256:" + Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function manifiesto(req: Request, env: Env, repo: string, digest: string, porEtiqueta = false): Promise<Response> {
  const r = await aGhcr(env, repo, `manifests/${digest}`, {
    method: req.method,
    headers: { Accept: req.headers.get("Accept") || ACCEPT_POR_DEFECTO },
  });
  if (!r) return error(502, "UNAVAILABLE", "upstream unavailable");
  if (r.status === 404) return error(404, "MANIFEST_UNKNOWN", "manifest unknown");
  if (r.status !== 200) {
    console.error(`registry: GHCR manifests ${r.status} (${repo})`);
    return error(502, "UNAVAILABLE", "upstream error");
  }
  const dcd = r.headers.get("Docker-Content-Digest");
  if (porEtiqueta) {
    // La firma de cosign se pide por etiqueta: su digest lo da GHCR y se
    // comprueba igual que el de los demás, contra el cuerpo (abajo, en GET).
    if (!dcd || !DIGEST.test(dcd)) return error(502, "DIGEST_INVALID", "upstream digest missing");
    digest = dcd;
  } else if (dcd && dcd !== digest) {
    console.error(`registry: digest distinto de GHCR (${repo})`);
    return error(502, "DIGEST_INVALID", "upstream digest mismatch");
  }
  const h = cabecerasBase({ "Docker-Content-Digest": digest });
  const ct = r.headers.get("Content-Type");
  if (ct) h.set("Content-Type", ct);
  if (req.method === "HEAD") {
    const cl = r.headers.get("Content-Length");
    if (cl) h.set("Content-Length", cl);
    return new Response(null, { status: 200, headers: h });
  }
  // El manifiesto es pequeño: se comprueba su hash, no solo lo que dice la cabecera.
  const cuerpo = await r.arrayBuffer();
  if ((await sha256(cuerpo)) !== digest) {
    console.error(`registry: el cuerpo del manifiesto no casa con su digest (${repo})`);
    return error(502, "DIGEST_INVALID", "upstream digest mismatch");
  }
  h.set("Content-Length", String(cuerpo.byteLength));
  return new Response(cuerpo, { status: 200, headers: h });
}

async function blob(req: Request, env: Env, repo: string, digest: string): Promise<Response> {
  const cab: Record<string, string> = {};
  const rango = req.headers.get("Range");
  if (rango) cab.Range = rango;
  // redirect: "manual": la capa se descarga del almacenamiento de GHCR con la URL firmada,
  // sin pasar por el Worker y sin credencial.
  const r = await aGhcr(env, repo, `blobs/${digest}`, { method: req.method, headers: cab, redirect: "manual" });
  if (!r) return error(502, "UNAVAILABLE", "upstream unavailable");
  if ([301, 302, 303, 307, 308].includes(r.status)) {
    const loc = r.headers.get("Location");
    if (!loc || !/^https:\/\//.test(loc)) return error(502, "UNAVAILABLE", "upstream error");
    return new Response(null, { status: r.status === 301 || r.status === 308 ? 307 : r.status, headers: cabecerasBase({ Location: loc }) });
  }
  if (r.status === 404) return error(404, "BLOB_UNKNOWN", "blob unknown");
  if (r.status !== 200 && r.status !== 206) {
    console.error(`registry: GHCR blobs ${r.status} (${repo})`);
    return error(502, "UNAVAILABLE", "upstream error");
  }
  const h = cabecerasBase({ "Docker-Content-Digest": digest });
  for (const n of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"]) {
    const v = r.headers.get(n);
    if (v) h.set(n, v);
  }
  return new Response(req.method === "HEAD" ? null : r.body, { status: r.status, headers: h });
}

// ── Enrutado ──

async function portador(req: Request, env: Env): Promise<Reclamos | null> {
  const secreto = secretoJwt(env);
  if (!secreto) return null;
  const m = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.headers.get("Authorization") ?? "");
  return m ? verificarJwt(m[1], secreto) : null;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const metodo = req.method;
    const lectura = metodo === "GET" || metodo === "HEAD";

    if (url.pathname === "/token" && metodo === "GET") return token(req, env, url);

    if ((url.pathname === "/v2/" || url.pathname === "/v2") && lectura) {
      const r = await portador(req, env);
      if (!r) return reto(undefined, req.headers.has("Authorization") ? "invalid_token" : undefined);
      return json(200, {});
    }

    const m = RUTA.exec(url.pathname);
    if (m && lectura) {
      const [, repo, tipo, ref] = m;
      if (!REPOS.includes(repo)) return error(404, "NAME_UNKNOWN", "repository name not known to registry");
      const scope = `repository:${repo}:pull`;
      const r = await portador(req, env);
      if (!r) return reto(scope, req.headers.has("Authorization") ? "invalid_token" : undefined);
      if (!r.access.some((a) => a.type === "repository" && a.name === repo && a.actions.includes("pull"))) {
        return reto(scope, "insufficient_scope");
      }
      if (tipo === "manifests") {
        // Solo por digest, y solo los concedidos: una etiqueta nunca resuelve aquí.
        const firma = ETIQUETA_DE_FIRMA.exec(ref);
        if (firma) {
          if (!r.digests.includes(`${repo}@sha256:${firma[1]}`)) return error(404, "MANIFEST_UNKNOWN", "manifest unknown");
          return manifiesto(req, env, repo, ref, true);
        }
        if (!DIGEST.test(ref) || !r.digests.includes(`${repo}@${ref}`)) {
          return error(404, "MANIFEST_UNKNOWN", "manifest unknown");
        }
        return manifiesto(req, env, repo, ref);
      }
      if (!DIGEST.test(ref)) return error(400, "DIGEST_INVALID", "invalid digest");
      return blob(req, env, repo, ref);
    }

    return error(404, "NOT_FOUND", "not found");
  },
};
