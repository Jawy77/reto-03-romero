// API HTTP del chat y archivos estáticos del front. La lógica del agente está en
// src/agent/ciclo.ts y las reglas de negocio en src/dominio/: este archivo solo
// transporta mensajes, mantiene sesiones y aplica límites.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { ejecutarTurno, nuevaSesion, type Dependencias, type Sesion } from "./agent/ciclo"
import type { AdaptadorLLM } from "./llm/adapter"
import { AdaptadorAnthropic } from "./llm/anthropic"
import { AdaptadorOpenAICompatible } from "./llm/openai-compatible"
import { AdaptadorSimulado } from "./llm/simulado"

const DIRECTORIO = join(import.meta.dir, "..")
const entero = (nombre: string, porDefecto: number) => {
  const valor = Number(process.env[nombre])
  return Number.isFinite(valor) && valor > 0 ? valor : porDefecto
}

const CONFIG = {
  puerto: entero("PORT", 3000),
  maxIteraciones: entero("MAX_ITERACIONES", 25),
  maxTokensSesion: entero("MAX_TOKENS_SESION", 200_000),
  maxTokensDia: entero("MAX_TOKENS_DIA", 2_000_000),
  maxSesiones: entero("MAX_SESIONES", 200),
  mensajesPorMinuto: entero("MENSAJES_POR_MINUTO", 20),
}

function crearAdaptador(): AdaptadorLLM {
  // Con || y no ??: una variable vacía en .env cuenta como no definida.
  const automatico = process.env.KIMI_API_KEY ? "kimi" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "simulado"
  const proveedor = process.env.LLM_PROVIDER || automatico
  const maxTokens = entero("LLM_MAX_TOKENS", 8000)
  const timeoutMs = entero("LLM_TIMEOUT_MS", 90_000)
  if (proveedor === "kimi" && process.env.KIMI_API_KEY) {
    return new AdaptadorOpenAICompatible({
      proveedor: "kimi",
      modelo: process.env.LLM_MODEL || "kimi-k2-turbo-preview",
      baseUrl: process.env.KIMI_BASE_URL || "https://api.moonshot.ai/v1",
      apiKey: process.env.KIMI_API_KEY,
      maxTokens,
      timeoutMs,
    })
  }
  if (proveedor === "anthropic") {
    const esfuerzo = z.enum(["low", "medium", "high", "xhigh", "max"]).catch("low").parse(process.env.LLM_EFFORT)
    return new AdaptadorAnthropic({ modelo: process.env.LLM_MODEL || "claude-opus-5-5", esfuerzo, maxTokens, timeoutMs })
  }
  return new AdaptadorSimulado()
}

const llm = crearAdaptador()
const sistema = [
  readFileSync(join(DIRECTORIO, "agent", "prompt.md"), "utf8"),
  readFileSync(join(DIRECTORIO, "src", "knowledge", "ordenes-compra.md"), "utf8"),
].join("\n\n---\n\n")

// ── Límites de costo y de uso ────────────────────────────────────────────────

const presupuesto = { dia: "", tokens: 0 }
function consumirPresupuesto(tokens: number): boolean {
  const hoy = new Date().toISOString().slice(0, 10)
  if (presupuesto.dia !== hoy) Object.assign(presupuesto, { dia: hoy, tokens: 0 })
  presupuesto.tokens += tokens
  return presupuesto.tokens < CONFIG.maxTokensDia
}
const presupuestoAgotado = () => presupuesto.dia === new Date().toISOString().slice(0, 10) && presupuesto.tokens >= CONFIG.maxTokensDia

const ventanas = new Map<string, number[]>()
function dentroDelLimite(ip: string): boolean {
  const ahora = Date.now()
  const recientes = (ventanas.get(ip) ?? []).filter((t) => ahora - t < 60_000)
  if (recientes.length >= CONFIG.mensajesPorMinuto) return false
  recientes.push(ahora)
  ventanas.set(ip, recientes)
  return true
}

// ── Sesiones en memoria ──────────────────────────────────────────────────────

const sesiones = new Map<string, Sesion>()
function obtenerSesion(id: string): Sesion {
  const existente = sesiones.get(id)
  if (existente) return existente
  if (sesiones.size >= CONFIG.maxSesiones) {
    const masAntigua = sesiones.keys().next().value
    if (masAntigua !== undefined) sesiones.delete(masAntigua)
  }
  const sesion = nuevaSesion(id)
  sesiones.set(id, sesion)
  return sesion
}

const deps: Dependencias = {
  llm,
  sistema,
  directorio: DIRECTORIO,
  maxIteraciones: CONFIG.maxIteraciones,
  maxTokensSesion: CONFIG.maxTokensSesion,
  consumirPresupuesto,
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const CABECERAS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}

function json(cuerpo: unknown, estado = 200): Response {
  return new Response(JSON.stringify(cuerpo), { status: estado, headers: { ...CABECERAS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } })
}

const ESTATICOS: Record<string, { archivo: string; tipo: string }> = {
  "/": { archivo: "index.html", tipo: "text/html; charset=utf-8" },
  "/app.js": { archivo: "app.js", tipo: "text/javascript; charset=utf-8" },
  "/estilos.css": { archivo: "estilos.css", tipo: "text/css; charset=utf-8" },
}

const SolicitudChat = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "sessionId inválido"),
  message: z.string().trim().min(1, "mensaje vacío").max(2000, "mensaje demasiado largo"),
})

async function chat(req: Request, ip: string): Promise<Response> {
  if (!dentroDelLimite(ip)) return json({ error: "Demasiados mensajes en un minuto. Espera un momento." }, 429)
  if (Number(req.headers.get("content-length") ?? 0) > 16_000) return json({ error: "Petición demasiado grande." }, 413)
  let cuerpo: unknown
  try {
    cuerpo = await req.json()
  } catch {
    return json({ error: "El cuerpo debe ser JSON." }, 400)
  }
  const entrada = SolicitudChat.safeParse(cuerpo)
  if (!entrada.success) return json({ error: entrada.error.issues.map((i) => i.message).join("; ") }, 400)
  if (presupuestoAgotado()) return json({ error: "El servicio alcanzó su tope diario de tokens. Intenta de nuevo mañana." }, 429)

  const sesion = obtenerSesion(entrada.data.sessionId)
  if (sesion.ocupada) return json({ error: "Esta sesión todavía está procesando el mensaje anterior." }, 409)
  sesion.ocupada = true
  try {
    return json(await ejecutarTurno(sesion, entrada.data.message, deps))
  } finally {
    sesion.ocupada = false
  }
}

function casos(): string[] {
  try {
    return readdirSync(join(DIRECTORIO, "fixtures", "reto-03", "solicitudes"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

const servidor = Bun.serve({
  port: CONFIG.puerto,
  idleTimeout: 180,
  async fetch(req, srv) {
    const url = new URL(req.url)
    const ip = srv.requestIP(req)?.address ?? "desconocida"
    try {
      if (req.method === "POST" && url.pathname === "/api/chat") return await chat(req, ip)
      if (req.method === "GET" && url.pathname === "/api/health") return json({ ok: true, provider: llm.proveedor, model: llm.modelo })
      if (req.method === "GET" && url.pathname === "/api/casos") return json({ casos: casos() })
      const sesionId = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{8,64})$/)?.[1]
      if (req.method === "GET" && sesionId) {
        const sesion = sesiones.get(sesionId)
        return sesion ? json({ sessionId: sesionId, historial: sesion.historial, tokens: sesion.tokens }) : json({ error: "Sesión no encontrada." }, 404)
      }
      const estatico = req.method === "GET" ? ESTATICOS[url.pathname] : undefined
      if (estatico) {
        return new Response(Bun.file(join(DIRECTORIO, "web", estatico.archivo)), { headers: { ...CABECERAS, "Content-Type": estatico.tipo } })
      }
      return json({ error: "Ruta no encontrada." }, 404)
    } catch {
      return json({ error: "Error interno del servidor." }, 500)
    }
  },
})

console.log(`Agente de órdenes de compra en http://localhost:${servidor.port} · proveedor: ${llm.proveedor} · modelo: ${llm.modelo}`)
if (llm instanceof AdaptadorOpenAICompatible) {
  // Diagnóstico de arranque: confirma que la credencial sirve y qué modelos ofrece la cuenta.
  const modelos = await llm.listarModelos()
  console.log(modelos.length ? `Modelos disponibles en ${llm.proveedor}: ${modelos.join(", ")}` : `No se pudo listar modelos en ${llm.proveedor}: revisa la clave y KIMI_BASE_URL.`)
}
