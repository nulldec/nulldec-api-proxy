import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env, firmarJwt, HOST, REALM, type Reclamos, reiniciarCacheGhcr, verificarJwt } from "./index.ts";

const CLAVE = "ndo_0a1b2c3d_" + "e".repeat(48);
const PREFIJO = "0a1b2c3d";
const SECRETO_CLAVE = "e".repeat(48);
const SECRETO = "s3cr3t0-de-prueba-del-registro-de-32+";
const ENV: Env = {
  REGISTRY_JWT_SECRET: SECRETO,
  GHCR_USER: "lector",
  GHCR_TOKEN: "ghp_token_de_prueba",
  NULLDEC_API: "https://api.example.test",
};

const MANIFIESTO = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json" });
let DIGEST_M = "";
const DIGEST_OTRO = "sha256:" + "1".repeat(64);
const DIGEST_BLOB = "sha256:" + "b".repeat(64);

async function sha(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return "sha256:" + Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

type Manejador = (req: Request) => Response | Promise<Response>;
let rutas: Record<string, Manejador>;
let llamadas: Request[];
let registros: string[];

function concesion(extra: Partial<{ repos: string[]; digests: string[] }> = {}): Manejador {
  return () =>
    Response.json({
      repos: ["deception-engine", "interactive-orchestrator", "nodo-agente"],
      digests: [`interactive-orchestrator@${DIGEST_M}`, `nodo-agente@${DIGEST_OTRO}`],
      expira_s: 300,
      ...extra,
    });
}

beforeEach(async () => {
  DIGEST_M = await sha(MANIFIESTO);
  reiniciarCacheGhcr();
  llamadas = [];
  registros = [];
  rutas = {
    "POST https://api.example.test/functions/v1/nodos/registro/token": concesion(),
    "GET https://ghcr.io/token": () => Response.json({ token: "ghcr-bearer", expires_in: 300 }),
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    llamadas.push(req);
    const u = new URL(req.url);
    const k = `${req.method} ${u.origin}${u.pathname}`;
    const h = rutas[k] ?? rutas[`* ${u.origin}${u.pathname}`];
    return h ? h(req) : new Response("no", { status: 599 });
  });
  for (const n of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, n).mockImplementation((...a: unknown[]) => {
      registros.push(a.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function basic(pass: string, user = "nodo"): string {
  return "Basic " + btoa(`${user}:${pass}`);
}

function pedir(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`https://${HOST}${path}`, init), ENV);
}

async function pedirToken(scopes: string[] = ["repository:interactive-orchestrator:pull"], pass = CLAVE): Promise<Response> {
  const q = new URLSearchParams({ service: HOST });
  for (const s of scopes) q.append("scope", s);
  return pedir(`/token?${q}`, { headers: { Authorization: basic(pass) } });
}

async function jwtValido(scopes?: string[]): Promise<string> {
  const r = await pedirToken(scopes);
  expect(r.status).toBe(200);
  return ((await r.json()) as { token: string }).token;
}

function bearer(t: string): RequestInit {
  return { headers: { Authorization: `Bearer ${t}` } };
}

async function reclamos(t: string): Promise<Reclamos> {
  const r = await verificarJwt(t, SECRETO);
  expect(r).not.toBeNull();
  return r!;
}

describe("GET /v2/ — el reto", () => {
  it("sin token: 401 con el reto Bearer y la versión de la API", async () => {
    const r = await pedir("/v2/");
    expect(r.status).toBe(401);
    expect(r.headers.get("WWW-Authenticate")).toBe(`Bearer realm="${REALM}",service="${HOST}"`);
    expect(r.headers.get("Docker-Distribution-API-Version")).toBe("registry/2.0");
  });

  it("con token inválido: 401", async () => {
    const r = await pedir("/v2/", bearer("a.b.c"));
    expect(r.status).toBe(401);
    expect(r.headers.get("WWW-Authenticate")).toContain(`realm="${REALM}"`);
  });

  it("con token válido (incluso sin scope, el de `docker login`): 200 {}", async () => {
    const t = await jwtValido([]);
    const r = await pedir("/v2/", bearer(t));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({});
  });
});

describe("GET /token", () => {
  it("emite un JWT de 300 s con el prefijo como sujeto y llama al backend con x-api-key", async () => {
    const r = await pedirToken();
    expect(r.status).toBe(200);
    const b = (await r.json()) as { token: string; access_token: string; expires_in: number; issued_at: string };
    expect(b.access_token).toBe(b.token);
    expect(b.expires_in).toBe(300);
    expect(Number.isNaN(Date.parse(b.issued_at))).toBe(false);
    const c = await reclamos(b.token);
    expect(c.sub).toBe(PREFIJO);
    expect(c.exp - c.iat).toBe(300);
    expect(c.access).toEqual([{ type: "repository", name: "interactive-orchestrator", actions: ["pull"] }]);
    expect(c.digests).toEqual([`interactive-orchestrator@${DIGEST_M}`]);

    const back = llamadas.find((q) => q.url.startsWith("https://api.example.test/"))!;
    expect(back.method).toBe("POST");
    expect(back.headers.get("x-api-key")).toBe(CLAVE);
  });

  it("scope = pedidos ∩ concedidos; los digests solo de esos repos", async () => {
    const t = await jwtValido([
      "repository:interactive-orchestrator:pull",
      "repository:nodo-agente:pull,push",
      "repository:hassh-sniffer:pull", // no concedido
      "repository:otro-repo:pull", // fuera de la lista
      "repository:deception-engine:push", // sin pull
    ]);
    const c = await reclamos(t);
    expect(c.access.map((a) => a.name)).toEqual(["interactive-orchestrator", "nodo-agente"]);
    expect(c.access.every((a) => a.actions.length === 1 && a.actions[0] === "pull")).toBe(true);
    expect(c.digests.sort()).toEqual([`interactive-orchestrator@${DIGEST_M}`, `nodo-agente@${DIGEST_OTRO}`]);
  });

  it("varios scopes en un mismo parámetro separados por espacio", async () => {
    const t = await jwtValido(["repository:interactive-orchestrator:pull repository:nodo-agente:pull"]);
    expect((await reclamos(t)).access.map((a) => a.name)).toEqual(["interactive-orchestrator", "nodo-agente"]);
  });

  it("clave con forma inválida o sin Basic: 401 sin llamar al backend", async () => {
    for (const init of [{}, { headers: { Authorization: basic("ndo_corta_x") } }, { headers: { Authorization: basic("ndg_0a1b2c3d_" + "e".repeat(48)) } }]) {
      const r = await pedir(`/token?service=${HOST}`, init);
      expect(r.status).toBe(401);
    }
    expect(llamadas.length).toBe(0);
  });

  it.each([
    [401, 401],
    [404, 401],
    [410, 401],
    [429, 429],
    [500, 503],
    [403, 503],
  ])("backend %i → %i", async (backend, esperado) => {
    rutas["POST https://api.example.test/functions/v1/nodos/registro/token"] = () =>
      new Response("{}", { status: backend, headers: backend === 429 ? { "Retry-After": "3600" } : {} });
    const r = await pedirToken();
    expect(r.status).toBe(esperado);
    if (esperado === 429) expect(r.headers.get("Retry-After")).toBe("3600");
    const texto = await r.text();
    expect(texto).not.toContain("token\"");
  });

  it("backend caído o con cuerpo mal formado → 503", async () => {
    rutas["POST https://api.example.test/functions/v1/nodos/registro/token"] = () => {
      throw new TypeError("network");
    };
    expect((await pedirToken()).status).toBe(503);
    rutas["POST https://api.example.test/functions/v1/nodos/registro/token"] = () => Response.json({ repos: "x" });
    expect((await pedirToken()).status).toBe(503);
  });

  it("sin REGISTRY_JWT_SECRET (o corto) falla en cerrado", async () => {
    for (const s of [undefined, "corto"]) {
      const r = await worker.fetch(new Request(`https://${HOST}/token`, { headers: { Authorization: basic(CLAVE) } }), {
        ...ENV,
        REGISTRY_JWT_SECRET: s,
      });
      expect(r.status).toBe(503);
    }
  });
});

describe("JWT", () => {
  const base = (): Reclamos => {
    const iat = Math.floor(Date.now() / 1000);
    return {
      iss: HOST,
      aud: HOST,
      sub: PREFIJO,
      iat,
      nbf: iat,
      exp: iat + 300,
      jti: "x",
      access: [{ type: "repository", name: "interactive-orchestrator", actions: ["pull"] }],
      digests: [`interactive-orchestrator@${DIGEST_M}`],
    };
  };

  it("caducado → rechazado", async () => {
    const t = await jwtValido();
    expect(await verificarJwt(t, SECRETO, Date.now() + 301_000)).toBeNull();
    const viejo = await firmarJwt({ ...base(), exp: Math.floor(Date.now() / 1000) - 1 }, SECRETO);
    expect((await pedir(`/v2/interactive-orchestrator/manifests/${DIGEST_M}`, bearer(viejo))).status).toBe(401);
  });

  it("firmado con otro secreto → rechazado", async () => {
    const falso = await firmarJwt(base(), "otro-secreto-de-mas-de-32-caracteres-xx");
    const r = await pedir(`/v2/interactive-orchestrator/manifests/${DIGEST_M}`, bearer(falso));
    expect(r.status).toBe(401);
    expect(r.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  });

  it("cuerpo manipulado (más repos) con la firma original → rechazado", async () => {
    const t = await jwtValido();
    const [h, , f] = t.split(".");
    const cuerpo = btoa(JSON.stringify({ ...base(), access: [{ type: "repository", name: "hassh-sniffer", actions: ["pull"] }] }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verificarJwt(`${h}.${cuerpo}.${f}`, SECRETO)).toBeNull();
  });

  it("alg none → rechazado", async () => {
    const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verificarJwt(`${enc({ alg: "none" })}.${enc(base())}.`, SECRETO)).toBeNull();
  });
});

describe("manifiestos", () => {
  beforeEach(() => {
    rutas[`* https://ghcr.io/v2/nulldec/interactive-orchestrator/manifests/${DIGEST_M}`] = (req) => {
      expect(req.headers.get("Authorization")).toBe("Bearer ghcr-bearer");
      return new Response(req.method === "HEAD" ? null : MANIFIESTO, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.oci.image.manifest.v1+json",
          "Docker-Content-Digest": DIGEST_M,
          "Content-Length": String(MANIFIESTO.length),
        },
      });
    };
  });

  it("digest concedido: proxy a GHCR con el Accept del cliente", async () => {
    const t = await jwtValido();
    const accept = "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json";
    const r = await pedir(`/v2/interactive-orchestrator/manifests/${DIGEST_M}`, {
      headers: { Authorization: `Bearer ${t}`, Accept: accept },
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(MANIFIESTO);
    expect(r.headers.get("Docker-Content-Digest")).toBe(DIGEST_M);
    expect(r.headers.get("Content-Type")).toBe("application/vnd.oci.image.manifest.v1+json");
    expect(r.headers.get("Content-Length")).toBe(String(MANIFIESTO.length));
    const aGhcr = llamadas.find((q) => q.url.includes("/manifests/"))!;
    expect(aGhcr.headers.get("Accept")).toBe(accept);
    const tok = llamadas.find((q) => q.url.startsWith("https://ghcr.io/token"))!;
    expect(new URL(tok.url).searchParams.get("scope")).toBe("repository:nulldec/interactive-orchestrator:pull");
    expect(tok.headers.get("Authorization")).toBe("Basic " + btoa("lector:ghp_token_de_prueba"));
  });

  it("HEAD también, y el token de GHCR se reutiliza en el aislado", async () => {
    const t = await jwtValido();
    expect((await pedir(`/v2/interactive-orchestrator/manifests/${DIGEST_M}`, { ...bearer(t), method: "HEAD" })).status).toBe(200);
    expect((await pedir(`/v2/interactive-orchestrator/manifests/${DIGEST_M}`, bearer(t))).status).toBe(200);
    expect(llamadas.filter((q) => q.url.startsWith("https://ghcr.io/token")).length).toBe(1);
  });

  it("una etiqueta se rechaza con MANIFEST_UNKNOWN, sin tocar GHCR", async () => {
    const t = await jwtValido();
    const r = await pedir("/v2/interactive-orchestrator/manifests/latest", bearer(t));
    expect(r.status).toBe(404);
    expect(((await r.json()) as { errors: { code: string }[] }).errors[0].code).toBe("MANIFEST_UNKNOWN");
    expect(llamadas.some((q) => q.url.startsWith("https://ghcr.io/"))).toBe(false);
  });

  it("digest no concedido → 404", async () => {
    const t = await jwtValido();
    const r = await pedir(`/v2/interactive-orchestrator/manifests/${DIGEST_OTRO}`, bearer(t));
    expect(r.status).toBe(404);
    expect(llamadas.some((q) => q.url.startsWith("https://ghcr.io/"))).toBe(false);
  });

  it("repo no concedido en el token → 401 insufficient_scope", async () => {
    const t = await jwtValido();
    const r = await pedir(`/v2/nodo-agente/manifests/${DIGEST_OTRO}`, bearer(t));
    expect(r.status).toBe(401);
    expect(r.headers.get("WWW-Authenticate")).toContain('scope="repository:nodo-agente:pull"');
    expect(r.headers.get("WWW-Authenticate")).toContain('error="insufficient_scope"');
  });

  it("repo fuera de la lista → 404 NAME_UNKNOWN", async () => {
    const t = await jwtValido();
    expect((await pedir(`/v2/otro/manifests/${DIGEST_M}`, bearer(t))).status).toBe(404);
  });

  it("Docker-Content-Digest distinto → 502", async () => {
    rutas[`* https://ghcr.io/v2/nulldec/interactive-orchestrator/manifests/${DIGEST_M}`] = () =>
      new Response(MANIFIESTO, { status: 200, headers: { "Docker-Content-Digest": DIGEST_OTRO } });
    const t = await jwtValido();
    expect((await pedir(`/v2/interactive-orchestrator/manifests/${DIGEST_M}`, bearer(t))).status).toBe(502);
  });

  it("cuerpo que no casa con el digest (sin cabecera) → 502", async () => {
    rutas[`* https://ghcr.io/v2/nulldec/interactive-orchestrator/manifests/${DIGEST_M}`] = () =>
      new Response(MANIFIESTO + " ", { status: 200 });
    const t = await jwtValido();
    expect((await pedir(`/v2/interactive-orchestrator/manifests/${DIGEST_M}`, bearer(t))).status).toBe(502);
  });

  it("GHCR 401 con el token cacheado: lo renueva una vez", async () => {
    let n = 0;
    const ok = rutas[`* https://ghcr.io/v2/nulldec/interactive-orchestrator/manifests/${DIGEST_M}`];
    rutas[`* https://ghcr.io/v2/nulldec/interactive-orchestrator/manifests/${DIGEST_M}`] = (req) =>
      ++n === 1 ? new Response(null, { status: 401 }) : ok(req);
    const t = await jwtValido();
    expect((await pedir(`/v2/interactive-orchestrator/manifests/${DIGEST_M}`, bearer(t))).status).toBe(200);
    expect(llamadas.filter((q) => q.url.startsWith("https://ghcr.io/token")).length).toBe(2);
  });
});

describe("blobs", () => {
  it("la redirección de GHCR pasa tal cual, pedida con redirect manual", async () => {
    const loc = "https://pkg-containers.githubusercontent.com/ghcr1/blobs/sha256:bbb?sig=x";
    let modo: RequestRedirect | undefined;
    rutas[`* https://ghcr.io/v2/nulldec/interactive-orchestrator/blobs/${DIGEST_BLOB}`] = (req) => {
      modo = req.redirect;
      return new Response(null, { status: 307, headers: { Location: loc } });
    };
    const t = await jwtValido();
    const r = await pedir(`/v2/interactive-orchestrator/blobs/${DIGEST_BLOB}`, bearer(t));
    expect(r.status).toBe(307);
    expect(r.headers.get("Location")).toBe(loc);
    expect(modo).toBe("manual");
  });

  it("200 de GHCR: el cuerpo pasa en streaming", async () => {
    rutas[`* https://ghcr.io/v2/nulldec/interactive-orchestrator/blobs/${DIGEST_BLOB}`] = () =>
      new Response("capa", { status: 200, headers: { "Content-Type": "application/octet-stream", "Content-Length": "4" } });
    const t = await jwtValido();
    const r = await pedir(`/v2/interactive-orchestrator/blobs/${DIGEST_BLOB}`, bearer(t));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("capa");
    expect(r.headers.get("Docker-Content-Digest")).toBe(DIGEST_BLOB);
  });

  it("digest mal formado → 400; repo no concedido → 401; sin token → 401", async () => {
    const t = await jwtValido();
    expect((await pedir("/v2/interactive-orchestrator/blobs/sha256:xyz", bearer(t))).status).toBe(400);
    expect((await pedir(`/v2/hassh-sniffer/blobs/${DIGEST_BLOB}`, bearer(t))).status).toBe(401);
    expect((await pedir(`/v2/interactive-orchestrator/blobs/${DIGEST_BLOB}`)).status).toBe(401);
  });
});

describe("todo lo demás", () => {
  it.each([
    ["GET", "/"],
    ["GET", "/v2/_catalog"],
    ["GET", "/v2/interactive-orchestrator/tags/list"],
    ["POST", "/token"],
    ["PUT", `/v2/interactive-orchestrator/manifests/sha256:${"a".repeat(64)}`],
  ])("%s %s → 404 JSON", async (method, path) => {
    const r = await pedir(path, { method });
    expect(r.status).toBe(404);
    expect(r.headers.get("Content-Type")).toBe("application/json");
  });
});

describe("la ndo_ nunca sale", () => {
  it("ni en respuestas ni en registros, en ningún camino", async () => {
    const vistas: string[] = [];
    const guardar = async (r: Response) => {
      vistas.push(r.status + JSON.stringify([...r.headers]) + (await r.text()));
    };
    await guardar(await pedirToken());
    for (const s of [401, 404, 410, 429, 500]) {
      rutas["POST https://api.example.test/functions/v1/nodos/registro/token"] = () => new Response("{}", { status: s });
      await guardar(await pedirToken());
    }
    rutas["POST https://api.example.test/functions/v1/nodos/registro/token"] = () => {
      throw new TypeError("network");
    };
    await guardar(await pedirToken());
    rutas["POST https://api.example.test/functions/v1/nodos/registro/token"] = () => Response.json({ nada: 1 });
    await guardar(await pedirToken());
    rutas["POST https://api.example.test/functions/v1/nodos/registro/token"] = concesion();
    const t = await jwtValido();
    expect(t).not.toContain(SECRETO_CLAVE);
    await guardar(await pedir(`/v2/interactive-orchestrator/manifests/${DIGEST_M}`, bearer(t)));
    await guardar(await pedir("/v2/", bearer(t)));

    const todo = vistas.join("\n") + "\n" + registros.join("\n") + "\n" + atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"));
    expect(todo).not.toContain(CLAVE);
    expect(todo).not.toContain(SECRETO_CLAVE);
    expect(todo).not.toContain("ghp_token_de_prueba");
    expect(registros.length).toBeGreaterThan(0); // los caminos de error sí registran algo
  });
});
