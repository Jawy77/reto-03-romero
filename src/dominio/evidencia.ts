// Evidencia de aprobación (HU-4, P0): el correo del líder con encabezados y
// su huella sha256. La huella se calcula sobre el contenido, no sobre el archivo,
// para que el payload de la OC pueda referenciarla sin depender del disco.
import { createHash } from "node:crypto"
import { PDFDocument, StandardFonts } from "pdf-lib"
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

/** Parte una línea larga en renglones que caben en la página. */
function renglones(linea: string, ancho: number): string[] {
  const salida: string[] = []
  let actual = ""
  for (const palabra of linea.split(" ")) {
    if (actual && (actual + " " + palabra).length > ancho) {
      salida.push(actual)
      actual = palabra
    } else {
      actual = actual ? `${actual} ${palabra}` : palabra
    }
  }
  salida.push(actual)
  return salida
}

/** HU-4 P1: la misma evidencia en PDF, lista para adjuntar a la orden en SAP. */
export async function pdfEvidencia(e: Evidencia): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const fuente = await pdf.embedFont(StandardFonts.Helvetica)
  // La fuente estándar solo cubre Latin-1: lo demás se reemplaza para no fallar.
  const texto = archivoEvidencia(e).replace(/[^\x20-\x7E\u00A0-\u00FF\n]/g, "?")
  const lineas = texto.split("\n").flatMap((l) => renglones(l, 92))
  const [ancho, alto, margen, salto] = [595, 842, 50, 15]
  let pagina = pdf.addPage([ancho, alto])
  let y = alto - margen
  for (const linea of lineas) {
    if (y < margen) {
      pagina = pdf.addPage([ancho, alto])
      y = alto - margen
    }
    pagina.drawText(linea, { x: margen, y, size: 10, font: fuente })
    y -= salto
  }
  return pdf.save()
}
