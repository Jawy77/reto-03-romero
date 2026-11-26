// Front del chat. Sin dependencias ni paso de compilación: el navegador lo carga tal cual.
// Todo texto que llega del servidor se escapa antes de insertarse en la página.

const $ = (id) => document.getElementById(id)
const mensajes = $("mensajes")
const texto = $("texto")
const enviar = $("enviar")

let sessionId = sessionStorage.getItem("sessionId") || nuevaId()
sessionStorage.setItem("sessionId", sessionId)

function nuevaId() {
  return crypto.randomUUID().replaceAll("-", "")
}

function escapar(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

// ── Markdown mínimo: tablas, listas, negritas y código ────────────────────────

function enLinea(s) {
  return escapar(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
}

function celdas(linea) {
  return linea.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
}

function markdown(fuente) {
  const lineas = fuente.split("\n")
  const html = []
  let i = 0
  while (i < lineas.length) {
    const linea = lineas[i]
    if (/^\s*\|/.test(linea) && /^\s*\|[\s:|-]+\|\s*$/.test(lineas[i + 1] || "")) {
      const cabecera = celdas(linea)
      i += 2
      const filas = []
      while (i < lineas.length && /^\s*\|/.test(lineas[i])) filas.push(celdas(lineas[i++]))
      html.push(
        `<div class="tabla"><table><thead><tr>${cabecera.map((c) => `<th>${enLinea(c)}</th>`).join("")}</tr></thead><tbody>${filas
          .map((f) => `<tr>${f.map((c) => `<td>${enLinea(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      )
      continue
    }
    if (/^\s*[-*]\s+/.test(linea)) {
      const items = []
      while (i < lineas.length && (/^\s*[-*]\s+/.test(lineas[i]) || /^\s{2,}\S/.test(lineas[i]))) {
        if (/^\s*[-*]\s+/.test(lineas[i])) items.push(enLinea(lineas[i].replace(/^\s*[-*]\s+/, "")))
        else items[items.length - 1] += `<br>${enLinea(lineas[i].trim())}`
        i++
      }
      html.push(`<ul>${items.map((it) => `<li>${it}</li>`).join("")}</ul>`)
      continue
    }
    if (/^#{1,4}\s+/.test(linea)) {
      html.push(`<p><strong>${enLinea(linea.replace(/^#{1,4}\s+/, ""))}</strong></p>`)
      i++
      continue
    }
    if (linea.trim() === "") {
      i++
      continue
    }
    const parrafo = []
    while (i < lineas.length && lineas[i].trim() !== "" && !/^\s*(\||[-*]\s|#{1,4}\s)/.test(lineas[i])) parrafo.push(enLinea(lineas[i++]))
    html.push(`<p>${parrafo.join("<br>")}</p>`)
  }
  return html.join("")
}

// ── Pintado ──────────────────────────────────────────────────────────────────

function agregar(nodo) {
  mensajes.appendChild(nodo)
  mensajes.scrollTop = mensajes.scrollHeight
  return nodo
}

function crear(etiqueta, clase, html) {
  const nodo = document.createElement(etiqueta)
  if (clase) nodo.className = clase
  if (html !== undefined) nodo.innerHTML = html
  return nodo
}

function resumir(llamada) {
  const r = llamada.resultado || {}
  if (!llamada.ok) return r.codigo ? `no procede · ${r.codigo}` : "error"
  const d = r.data || {}
  if (d.numero_oc) return `OC ${d.numero_oc}${d.idempotente ? " (existente)" : ""}`
  if (typeof d.apta === "boolean") return `apta: ${d.apta ? "sí" : "no"} · ${d.bloqueos.length} bloqueos · ${d.confirmaciones.length} confirmaciones`
  if (d.sha256) return `sha256 ${d.sha256.slice(0, 12)}…`
  if (d.orden) return "payload construido"
  if (d.solicitud) return d.solicitud.solicitud_id
  return "ok"
}

function pintarLlamada(llamada) {
  const detalle = crear("details", `herramienta${llamada.ok ? "" : " fallida"}`)
  detalle.innerHTML = `<summary><span class="nombre">${escapar(llamada.nombre)}</span><span class="args">${escapar(
    JSON.stringify(llamada.argumentos),
  )}</span><span class="resumen">${escapar(resumir(llamada))} · ${llamada.ms} ms</span></summary><pre>${escapar(
    JSON.stringify({ argumentos: llamada.argumentos, resultado: llamada.resultado }, null, 2),
  )}</pre>`
  agregar(detalle)
}

function pintarRespuesta(respuesta) {
  for (const llamada of respuesta.toolCalls || []) pintarLlamada(llamada)
  const burbuja = crear("div", `burbuja asistente${respuesta.needsConfirmation ? " confirmar" : ""}`)
  burbuja.innerHTML = (respuesta.needsConfirmation ? '<span class="etiqueta">Requiere tu confirmación</span>' : "") + markdown(respuesta.reply || "")
  if (respuesta.needsConfirmation) {
    const acciones = crear("div", "acciones")
    const si = crear("button", "primario", "Confirmo")
    const no = crear("button", "secundario", "No crear")
    si.type = no.type = "button"
    si.addEventListener("click", () => mandar("Confirmo, crea la orden."))
    no.addEventListener("click", () => mandar("No la crees."))
    acciones.append(si, no)
    burbuja.appendChild(acciones)
  }
  agregar(burbuja)
}

function bloquear(activo) {
  enviar.disabled = activo
  for (const boton of document.querySelectorAll(".caso, .acciones button")) boton.disabled = activo
}

async function mandar(mensaje) {
  const limpio = mensaje.trim()
  if (!limpio || enviar.disabled) return
  for (const viejas of document.querySelectorAll(".acciones")) viejas.remove()
  agregar(crear("div", "burbuja usuario")).textContent = limpio
  texto.value = ""
  texto.style.height = "auto"
  bloquear(true)
  const pensando = agregar(crear("div", "pensando", "El agente está trabajando"))
  try {
    const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, message: limpio }) })
    const cuerpo = await r.json()
    pensando.remove()
    if (!r.ok) agregar(crear("div", "burbuja asistente fallo")).textContent = cuerpo.error || "El servidor no pudo procesar el mensaje."
    else pintarRespuesta(cuerpo)
  } catch {
    pensando.remove()
    agregar(crear("div", "burbuja asistente fallo")).textContent = "No hubo conexión con el servidor. Intenta de nuevo."
  } finally {
    bloquear(false)
    texto.focus()
  }
}

// ── Arranque ─────────────────────────────────────────────────────────────────

function bienvenida() {
  mensajes.innerHTML = ""
  agregar(
    crear(
      "div",
      "burbuja asistente",
      markdown('Hola. Dime qué solicitud quieres procesar, por ejemplo **procesa la solicitud "sol-001"**, o elige un caso de la izquierda. Leo el paquete, lo valido contra los maestros y creo la orden en SAP; si algo necesita tu decisión, te pregunto antes.'),
    ),
  )
}

$("formulario").addEventListener("submit", (e) => {
  e.preventDefault()
  mandar(texto.value)
})
texto.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault()
    mandar(texto.value)
  }
})
texto.addEventListener("input", () => {
  texto.style.height = "auto"
  texto.style.height = `${Math.min(texto.scrollHeight, 140)}px`
})
$("nueva").addEventListener("click", () => {
  sessionId = nuevaId()
  sessionStorage.setItem("sessionId", sessionId)
  bienvenida()
})
$("demo").addEventListener("click", () =>
  mandar('Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.'),
)

fetch("/api/health")
  .then((r) => r.json())
  .then((s) => ($("proveedor").textContent = `${s.provider} · ${s.model}`))
  .catch(() => ($("proveedor").textContent = "sin conexión"))

fetch("/api/casos")
  .then((r) => r.json())
  .then(({ casos }) => {
    for (const caso of casos) {
      const boton = crear("button", "caso")
      boton.type = "button"
      boton.textContent = caso
      boton.addEventListener("click", () => mandar(`Procesa la solicitud "${caso}".`))
      $("casos").appendChild(boton)
    }
  })
  .catch(() => {})

// Al recargar la página se recupera la conversación de la sesión, si el servidor aún la tiene.
async function restaurar() {
  bienvenida()
  try {
    const r = await fetch(`/api/sessions/${sessionId}`)
    if (!r.ok) return
    const { historial } = await r.json()
    historial.forEach((entrada, i) => {
      if (entrada.rol === "usuario") agregar(crear("div", "burbuja usuario")).textContent = entrada.texto
      else pintarRespuesta({ reply: entrada.texto, toolCalls: entrada.toolCalls, needsConfirmation: entrada.needsConfirmation && i === historial.length - 1 })
    })
  } catch {
    // Sin historial: se queda la bienvenida.
  }
}

restaurar()
