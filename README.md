# Reto 03 · Agente de órdenes de compra sobre SAP simulado

Agente conversacional que lee el paquete de una solicitud de compra, lo valida contra los maestros con diez reglas de control, muestra la orden como quedaría en SAP, genera la evidencia de aprobación y crea la orden en un SAP simulado. Las excepciones no se fuerzan: se bloquean o se devuelven a la analista para que confirme.

**Link de prueba:** http://52.3.131.158 (sin clave de acceso)

El planteamiento completo está en [`SOLUCION.md`](SOLUCION.md).

## Levantar en local

Requiere [Bun](https://bun.sh) 1.4 o superior. Un comando levanta front y backend en http://localhost:3000:

```bash
bun install && bun run dev
```

Con Docker:

```bash
docker compose up --build
```

Sin clave de modelo, la aplicación arranca en **modo simulado**: el chat y el ciclo del agente funcionan con un proveedor de reglas fijas, sin modelo de lenguaje. Para usar un modelo real, copia `.env.example` como `.env` y completa `ANTHROPIC_API_KEY`.

## Verificar sin modelo

```bash
bun install && bun run demo.ts
```

`demo.ts` procesa los seis casos llamando directamente a las herramientas, sin clave de ningún proveedor. Muestra por caso si es apta, los bloqueos, las confirmaciones, si es retroactiva y el número de OC o el motivo. También ejecuta `sol-001` dos veces para mostrar la idempotencia, confirma `sol-004` de forma explícita e intenta crear una orden con el precio alterado para mostrar que se rechaza. Termina con código 1 si algún caso no da el resultado que exige el PRD.

| Comando | Qué hace |
|---|---|
| `bun run demo.ts` | Los 6 casos sin modelo |
| `bun test` | 17 pruebas de las reglas con variaciones que los fixtures no cubren |
| `bun run typecheck` | TypeScript en modo estricto |
| `bun run verificar` | Las tres anteriores en cadena |
| `bun run modulo` | Regenera `modulo/` desde las fuentes de la aplicación |

## Variables de entorno

Todas son opcionales; los valores por defecto están en [`.env.example`](.env.example).

| Variable | Por defecto | Para qué |
|---|---|---|
| `ANTHROPIC_API_KEY` | vacía | Clave del modelo. Solo la lee el backend. |
| `LLM_PROVIDER` | automático | `anthropic` o `simulado`. Vacía: `anthropic` si hay clave; si no, `simulado`. |
| `LLM_MODEL` | `claude-opus-5-5` | Modelo del proveedor. |
| `LLM_EFFORT` | `low` | Nivel de esfuerzo del modelo. |
| `MAX_ITERACIONES` | `25` | Tope de pasos herramienta → modelo por turno. |
| `MAX_TOKENS_SESION` | `200000` | Tope de tokens por sesión. |
| `MAX_TOKENS_DIA` | `2000000` | Tope diario de tokens para todo el servicio. |
| `MENSAJES_POR_MINUTO` | `20` | Límite de mensajes por dirección IP. |
| `PORT` | `3000` | Puerto del servidor. |
| `PUERTO_PUBLICO` | `3000` | Puerto que publica `docker compose`. |

## API

| Método | Ruta | Cuerpo y respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, tokensSesion }` |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión, con las llamadas a herramientas de cada turno |
| `GET` | `/api/health` | `{ ok, provider, model }`, sin exponer claves |
| `GET` | `/api/casos` | Casos disponibles en los fixtures |

`sessionId` es una cadena de 8 a 64 caracteres alfanuméricos que genera el cliente. Cada elemento de `toolCalls` trae `nombre`, `argumentos`, `ok`, `resultado` y `ms`.

## Probar en el chat

En una sesión nueva:

```
Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué
validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.
```

El agente muestra la orden en una tabla, los controles, la confirmación pendiente con los dos valores (solicitud y cotización) y cierra con una pregunta resaltada. Al responder "Confirmo", devuelve el número de OC y la ruta de la evidencia.

## Estructura

```
agent/prompt.md              comportamiento del agente (system prompt)
src/knowledge/               conocimiento del proceso
src/tools/oc.ts              herramientas oc_* tipadas con zod
src/dominio/                 reglas de control, payload, evidencia y log de control
src/sap/                     interfaz SapAdapter y SAP simulado sobre archivos
src/llm/                     interfaz AdaptadorLLM, Anthropic y proveedor simulado
src/agent/ciclo.ts           ciclo del agente, topes y confirmación humana
src/server.ts                API HTTP y archivos estáticos
web/                         front de chat (HTML, CSS y JavaScript planos)
modulo/                      agente empaquetado como módulo reutilizable
tests/                       pruebas de las reglas
demo.ts                      verificación sin modelo
fixtures/                    entregados por Periferia, sin modificar
out/                         generado en ejecución (no se versiona)
```
