// Log de control para Contabilidad y Auditoría (HU-5): una fila por intento,
// sea exitoso, bloqueado o pendiente de confirmación.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type ResultadoControl = "creada" | "existente" | "bloqueada" | "pendiente_confirmacion" | "error"

export type FilaControl = {
  solicitud_id: string
  resultado: ResultadoControl
  numero_oc: string
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
}

const ENCABEZADO = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n"

function celda(valor: string): string {
  return /[",\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor
}

export function registrarControl(directorio: string, fila: FilaControl): void {
  const carpeta = join(directorio, "out")
  const archivo = join(carpeta, "control.csv")
  mkdirSync(carpeta, { recursive: true })
  if (!existsSync(archivo)) writeFileSync(archivo, ENCABEZADO, "utf8")
  const linea = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc,
    String(fila.retroactiva),
    fila.bloqueos.join("|"),
    fila.confirmaciones.join("|"),
    new Date().toISOString(),
  ]
    .map(celda)
    .join(",")
  appendFileSync(archivo, `${linea}\n`, "utf8")
}
