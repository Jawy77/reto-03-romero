// Evidencia de aprobación (HU-4, P0): el correo del líder con encabezados y
// su huella sha256. La huella se calcula sobre el contenido, no sobre el archivo,
// para que el payload de la OC pueda referenciarla sin depender del disco.
import { createHash } from "node:crypto"
import type { Resultado } from "./esquemas"
import { leerAprobacionCruda } from "./lectura"

export type Evidencia = { contenido: string; sha256: string }

export function construirEvidencia(directorio: string, caso: string): Resultado<Evidencia> {
  const aprobacion = leerAprobacionCruda(directorio, caso)
  if (!aprobacion.ok) return aprobacion
  if (!aprobacion.valor) {
    return { ok: false, error: "No hay correo de aprobación en el paquete: no se puede generar la evidencia." }
  }
  const a = aprobacion.valor
  const contenido = [
    "EVIDENCIA DE APROBACIÓN DE ORDEN DE COMPRA",
    `Caso: ${caso}`,
    `De: ${a.de}`,
    `Para: ${a.para ?? "(no informado)"}`,
    `Fecha: ${a.fecha}`,
    `Asunto: ${a.asunto ?? "(sin asunto)"}`,
    "",
    a.cuerpo,
    "",
  ].join("\n")
  return { ok: true, valor: { contenido, sha256: createHash("sha256").update(contenido, "utf8").digest("hex") } }
}

export function archivoEvidencia(e: Evidencia): string {
  return `${e.contenido}---\nsha256: ${e.sha256}\n`
}
