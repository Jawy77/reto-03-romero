// Genera ejemplos/solicitud-sol-001.xlsx a partir del fixture de sol-001, para
// probar oc_leer_excel con un Excel real sin modificar los fixtures de Periferia.
//
//   bun run scripts/generar-ejemplo-excel.ts
import ExcelJS from "exceljs"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const RAIZ = join(import.meta.dir, "..")
const solicitud = JSON.parse(readFileSync(join(RAIZ, "fixtures", "reto-03", "solicitudes", "sol-001", "solicitud.json"), "utf8")) as Record<string, string | number>

const libro = new ExcelJS.Workbook()
libro.created = new Date("2026-08-20T09:00:00-05:00") // fecha fija: el archivo no cambia entre ejecuciones
libro.modified = libro.created
const hoja = libro.addWorksheet("Solicitud")
hoja.addRow(Object.keys(solicitud))
hoja.addRow(Object.values(solicitud))
hoja.getRow(1).font = { bold: true }

mkdirSync(join(RAIZ, "ejemplos"), { recursive: true })
await libro.xlsx.writeFile(join(RAIZ, "ejemplos", "solicitud-sol-001.xlsx"))
console.log("generado ejemplos/solicitud-sol-001.xlsx")
