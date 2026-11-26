// Genera modulo/ a partir de las mismas piezas que usa la aplicación, para que
// el módulo reutilizable nunca diverja de ella:
//   agent/prompt.md                 → modulo/agent.md
//   src/knowledge/ordenes-compra.md → modulo/skill/ordenes-compra/SKILL.md
//   src/tools/oc.ts                 → modulo/tools/oc.ts (reexportación)
//
//   bun run modulo           genera los archivos
//   bun run modulo --check   falla si lo generado no coincide con lo que hay en disco
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const RAIZ = join(import.meta.dir, "..")
const leer = (ruta: string) => readFileSync(join(RAIZ, ruta), "utf8")

const AVISO = "<!-- Generado por scripts/build-modulo.ts. No editar: cambia el archivo de origen y ejecuta `bun run modulo`. -->"

const archivos: Record<string, string> = {
  "modulo/agent.md": [
    "---",
    "description: Prepara y crea órdenes de compra en SAP a partir del paquete de solicitud, con controles de aprobación y confirmación humana",
    "mode: primary",
    "permission:",
    "  edit: deny",
    "  bash: deny",
    "---",
    "",
    AVISO,
    "",
    leer("agent/prompt.md"),
  ].join("\n"),
  "modulo/skill/ordenes-compra/SKILL.md": [
    "---",
    "name: ordenes-compra",
    "description: Reglas de control RC1 a RC10, criterios de confirmación y archivos del proceso de órdenes de compra. Úsalo al procesar, validar o explicar una solicitud de compra.",
    "---",
    "",
    AVISO,
    "",
    leer("src/knowledge/ordenes-compra.md"),
  ].join("\n"),
  "modulo/tools/oc.ts": [
    "// Las mismas herramientas que usa la aplicación, importables sin el servidor.",
    "// Cada export es una herramienta { description, args, execute } y se publica como oc_<export>.",
    "// Generado por scripts/build-modulo.ts: es una reexportación, no una copia.",
    'export { construir_payload, crear, generar_evidencia, leer_excel, leer_paquete, validar } from "../../src/tools/oc"',
    "",
  ].join("\n"),
}

const soloVerificar = process.argv.includes("--check")
const desfasados: string[] = []
for (const [ruta, contenido] of Object.entries(archivos)) {
  const destino = join(RAIZ, ruta)
  if (soloVerificar) {
    if (!existsSync(destino) || readFileSync(destino, "utf8") !== contenido) desfasados.push(ruta)
    continue
  }
  mkdirSync(dirname(destino), { recursive: true })
  writeFileSync(destino, contenido, "utf8")
  console.log(`generado ${ruta}`)
}
if (desfasados.length) {
  console.error(`modulo/ está desfasado respecto a sus fuentes: ${desfasados.join(", ")}. Ejecuta: bun run modulo`)
  process.exit(1)
}
if (soloVerificar) console.log("modulo/ coincide con sus fuentes.")
