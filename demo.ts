// Verificación sin modelo de lenguaje: procesa los 6 casos llamando directamente
// a las herramientas. No necesita clave de ningún proveedor.
//
//   bun install && bun run demo.ts
//
// Sale con código 1 si algún caso no da el resultado que exige el PRD.
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import * as oc from "./src/tools/oc"
import type { Hallazgo } from "./src/dominio/esquemas"
import type { Contexto } from "./src/tools/tipos"

const ctx: Contexto = { directory: import.meta.dir, sessionId: "demo" }

type Respuesta = { ok: boolean; data?: Record<string, unknown>; error?: string; codigo?: string }
const leer = (crudo: string): Respuesta => JSON.parse(crudo) as Respuesta

type Esperado = { apta: boolean; confirma: boolean; retroactiva: boolean; oc: string | null }
const ESPERADO: Record<string, Esperado> = {
  "sol-001": { apta: true, confirma: false, retroactiva: false, oc: "4500000001" },
  "sol-002": { apta: false, confirma: false, retroactiva: false, oc: null },
  "sol-003": { apta: false, confirma: false, retroactiva: false, oc: null },
  "sol-004": { apta: true, confirma: true, retroactiva: false, oc: "4500000002" },
  "sol-005": { apta: true, confirma: true, retroactiva: true, oc: "4500000003" },
  "sol-006": { apta: true, confirma: true, retroactiva: false, oc: "4500000004" },
}

const fallas: string[] = []
const verificar = (condicion: boolean, mensaje: string) => {
  if (!condicion) fallas.push(mensaje)
}
const lista = (hallazgos: Hallazgo[]) => (hallazgos.length ? hallazgos.map((h) => `${h.regla} ${h.codigo}`).join(", ") : "ninguno")

/** Simula a un modelo que "arregla" el precio para que cuadre con la cotización: debe rechazarse. */
async function probarIntegridad(caso: string, orden: unknown): Promise<void> {
  const original = orden as { posiciones: Array<{ precio_unitario: number }> }
  const alterada = { ...original, posiciones: original.posiciones.map((p) => ({ ...p, precio_unitario: 265000 })) }
  const rechazo = leer(await oc.crear.execute({ caso, payload: alterada, confirmado: true }, ctx))
  console.log(`  payload alterado (precio 265.000 en vez de 250.000): ${rechazo.ok ? "ACEPTADO (mal)" : `rechazado (${rechazo.codigo})`}`)
  verificar(!rechazo.ok && rechazo.codigo === "PAYLOAD_ALTERADO", "integridad: se aceptó un payload con el precio alterado")
}

async function procesar(caso: string): Promise<void> {
  const esperado = ESPERADO[caso]
  if (!esperado) return
  console.log(`\n━━ ${caso} ${"━".repeat(60)}`)

  const paquete = leer(await oc.leer_paquete.execute({ caso }, ctx))
  if (!paquete.ok || !paquete.data) {
    console.log(`  error de lectura: ${paquete.error}`)
    fallas.push(`${caso}: no se pudo leer`)
    return
  }
  const validacion = leer(await oc.validar.execute({ caso, paquete: paquete.data }, ctx))
  const v = validacion.data as { apta: boolean; bloqueos: Hallazgo[]; confirmaciones: Hallazgo[]; retroactiva: boolean; derivados: Record<string, { valor: string }> }
  console.log(`  apta:           ${v.apta}`)
  console.log(`  bloqueos:       ${lista(v.bloqueos)}`)
  console.log(`  confirmaciones: ${lista(v.confirmaciones)}`)
  console.log(`  retroactiva:    ${v.retroactiva}`)
  const derivados = Object.entries(v.derivados).map(([campo, d]) => `${campo}=${d.valor}`)
  if (derivados.length) console.log(`  derivados:      ${derivados.join(", ")}`)
  verificar(v.apta === esperado.apta, `${caso}: apta=${v.apta}, se esperaba ${esperado.apta}`)
  verificar(v.confirmaciones.length > 0 === esperado.confirma, `${caso}: confirmaciones inesperadas`)
  verificar(v.retroactiva === esperado.retroactiva, `${caso}: retroactiva=${v.retroactiva}`)

  if (!v.apta) {
    const intento = leer(await oc.crear.execute({ caso }, ctx))
    for (const b of v.bloqueos) console.log(`  motivo:         ${b.mensaje}\n  acción:         ${b.accion_sugerida}`)
    verificar(!intento.ok && intento.codigo === "BLOQUEADA", `${caso}: una solicitud bloqueada no debe crear OC`)
    return
  }

  const payload = leer(await oc.construir_payload.execute({ caso, paquete: paquete.data, derivados: v.derivados }, ctx))
  const evidencia = leer(await oc.generar_evidencia.execute({ caso }, ctx))
  console.log(`  trazabilidad:   ${payload.data?.ruta_trazabilidad}`)
  console.log(`  evidencia:      ${evidencia.data?.ruta} (sha256 ${String(evidencia.data?.sha256).slice(0, 16)}…)`)

  let creada = leer(await oc.crear.execute({ caso, payload: payload.data?.orden }, ctx))
  if (esperado.confirma) {
    verificar(!creada.ok && creada.codigo === "REQUIERE_CONFIRMACION", `${caso}: debió pedir confirmación antes de crear`)
    console.log(`  sin confirmar:  ${creada.error}`)
    if (caso === "sol-004") await probarIntegridad(caso, payload.data?.orden)
    console.log("  → confirmación explícita de la analista (confirmado = true)")
    creada = leer(await oc.crear.execute({ caso, payload: payload.data?.orden, confirmado: true }, ctx))
  }
  console.log(`  número de OC:   ${creada.data?.numero_oc ?? `no creada (${creada.error})`}`)
  verificar(creada.data?.numero_oc === esperado.oc, `${caso}: OC ${String(creada.data?.numero_oc)}, se esperaba ${esperado.oc}`)
}

rmSync(join(ctx.directory, "out"), { recursive: true, force: true })
console.log("Reto 03 · Órdenes de compra SAP · verificación sin modelo")

for (const caso of Object.keys(ESPERADO)) await procesar(caso)

console.log(`\n━━ Idempotencia: sol-001 por segunda vez ${"━".repeat(31)}`)
const repetida = leer(await oc.crear.execute({ caso: "sol-001" }, ctx))
console.log(`  número de OC:   ${repetida.data?.numero_oc} (idempotente: ${repetida.data?.idempotente})`)
verificar(repetida.data?.numero_oc === "4500000001" && repetida.data?.idempotente === true, "idempotencia: sol-001 generó una segunda OC")

console.log(`\n━━ Errores: entradas inválidas ${"━".repeat(41)}`)
for (const caso of ["sol-999", "../../maestros"]) {
  const r = leer(await oc.leer_paquete.execute({ caso }, ctx))
  console.log(`  ${caso.padEnd(15)} ${r.ok ? "LEÍDO (mal)" : r.error}`)
  verificar(!r.ok, `errores: "${caso}" debió devolver ok=false`)
}

const ordenes = join(ctx.directory, "out", "sap", "ordenes.jsonl")
console.log(`\n━━ SAP simulado (out/sap/ordenes.jsonl) ${"━".repeat(33)}`)
const creadas = existsSync(ordenes) ? readFileSync(ordenes, "utf8").trim().split("\n") : []
for (const linea of creadas) {
  const r = JSON.parse(linea) as { numero_oc: string; orden: { referencia: { solicitud_id: string }; proveedor: { nombre: string } } }
  console.log(`  ${r.numero_oc}  ${r.orden.referencia.solicitud_id}  ${r.orden.proveedor.nombre}`)
}
verificar(creadas.length === 4, `SAP simulado: ${creadas.length} órdenes, se esperaban 4`)

const control = join(ctx.directory, "out", "control.csv")
console.log(`\n━━ Log de control (out/control.csv) ${"━".repeat(36)}`)
if (existsSync(control)) console.log(readFileSync(control, "utf8").trimEnd().split("\n").map((l) => `  ${l}`).join("\n"))

console.log(fallas.length ? `\n✗ ${fallas.length} verificación(es) fallaron:\n${fallas.map((f) => `  - ${f}`).join("\n")}` : "\n✓ Los 6 casos, la idempotencia y la integridad del payload dieron el resultado esperado.")
process.exit(fallas.length ? 1 : 0)
