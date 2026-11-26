// Lectura de un Excel real de solicitud (P1). La primera fila se toma como
// encabezado y cada fila siguiente se devuelve como un objeto.
import ExcelJS from "exceljs"
import { existsSync, statSync } from "node:fs"
import { isAbsolute, join, normalize, sep } from "node:path"
import type { Resultado } from "./esquemas"

export type Celda = string | number | boolean | null
export type Fila = Record<string, Celda>

const TAMANO_MAXIMO = 2 * 1024 * 1024 // 2 MB
const CARPETAS_PERMITIDAS = ["fixtures", "ejemplos"]

/** Solo rutas relativas, dentro de las carpetas de datos y con extensión .xlsx. */
export function rutaSegura(directorio: string, ruta: string): Resultado<string> {
  const limpia = normalize(ruta)
  const permitida = CARPETAS_PERMITIDAS.some((carpeta) => limpia.startsWith(`${carpeta}${sep}`))
  if (isAbsolute(ruta) || limpia.startsWith("..") || !permitida) {
    return { ok: false, error: `Ruta no permitida: "${ruta}". Debe ser relativa y estar dentro de ${CARPETAS_PERMITIDAS.join("/ o ")}/.` }
  }
  if (!limpia.toLowerCase().endsWith(".xlsx")) return { ok: false, error: "Solo se leen archivos .xlsx." }
  const completa = join(directorio, limpia)
  if (!existsSync(completa)) return { ok: false, error: `No existe el archivo "${ruta}".` }
  if (statSync(completa).size > TAMANO_MAXIMO) return { ok: false, error: "El archivo supera el tamaño máximo de 2 MB." }
  return { ok: true, valor: completa }
}

/** Reduce cualquier valor de celda (fórmula, fecha, texto enriquecido) a un valor simple. */
function simple(valor: ExcelJS.CellValue): Celda {
  if (valor === null || valor === undefined) return null
  if (typeof valor === "string" || typeof valor === "number" || typeof valor === "boolean") return valor
  if (valor instanceof Date) return valor.toISOString().slice(0, 10)
  if ("result" in valor) return simple(valor.result as ExcelJS.CellValue)
  if ("richText" in valor) return valor.richText.map((t) => t.text).join("")
  if ("text" in valor) return String(valor.text)
  return String(valor)
}

export async function leerExcel(directorio: string, ruta: string): Promise<Resultado<{ hoja: string; filas: Fila[] }>> {
  const segura = rutaSegura(directorio, ruta)
  if (!segura.ok) return segura
  const libro = new ExcelJS.Workbook()
  try {
    await libro.xlsx.readFile(segura.valor)
  } catch {
    return { ok: false, error: `"${ruta}" no es un Excel válido o está dañado.` }
  }
  const hoja = libro.worksheets[0]
  if (!hoja || hoja.rowCount < 2) return { ok: false, error: "El Excel no tiene una fila de encabezados y al menos una fila de datos." }

  const encabezados: string[] = []
  hoja.getRow(1).eachCell((celda, columna) => (encabezados[columna] = String(simple(celda.value) ?? "").trim()))
  const filas: Fila[] = []
  for (let n = 2; n <= hoja.rowCount; n++) {
    const fila: Fila = {}
    encabezados.forEach((nombre, columna) => {
      if (nombre) fila[nombre] = simple(hoja.getRow(n).getCell(columna).value)
    })
    if (Object.values(fila).some((v) => v !== null)) filas.push(fila)
  }
  return { ok: true, valor: { hoja: hoja.name, filas } }
}
