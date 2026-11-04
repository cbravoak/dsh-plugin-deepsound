# dsh-plugin-deepsound

Sonidos configurables para la interfaz y las notificaciones de DeepSeek Harness.

Añade una sección **Sounds** en Ajustes donde puedes elegir un perfil de sonido
(Moderado, Completo o Silencio), ajustar el volumen, y afinar qué suena en cada
evento por separado.

Todos los sonidos están **sintetizados con la Web Audio API**: el plugin no
incluye ningún archivo de audio. Esto evita problemas de CSP (la GUI se sirve
desde `http://127.0.0.1`) y mantiene el paquete en unos pocos KB.

## Qué suena

| Evento | Descripción | Sonido por defecto (Moderado) |
|---|---|---|
| Turn finished | El agente terminó de responder | Chime |
| Turn failed | El agente se detuvo por un error | Error |
| Approval requested | Una herramienta pide tu aprobación | Notify |
| Question asked | El agente te hace una pregunta | Bell |
| Subagent finished | Un subagente terminó su trabajo | — (solo en Completo) |
| Job finished | Una tarea en segundo plano terminó | — (solo en Completo) |
| Session started | Se creó una sesión nueva | — (solo en Completo) |
| Goal updated | Cambió el estado de un goal | — (solo en Completo) |
| Model working | El modelo está pensando o ejecutando trabajo | Pulso suave cada 5 segundos |

## Perfiles de sonido

- **Moderado** — lo esencial: fin de turno, errores, aprobaciones, preguntas y un pulso tenue mientras el modelo trabaja.
- **Completo** — todo lo anterior más subagentes, tareas en segundo plano,
  sesiones nuevas y goals.
- **Silencio** — ningún sonido.
- **Personalizado** — conserva tu selección por evento.

Elegir un perfil rellena la lista de eventos; después puedes cambiar cualquier
evento por separado (eso pasa el perfil a *Personalizado*). Nada se guarda hasta
que pulsas **Guardar**.

## Sonidos disponibles

`none`, `chime`, `bell`, `ding`, `pop`, `blip`, `marimba`, `piano`, `alarm`,
`success`, `error`, `notify`, `work`, `workLoop`.

Para **Model working** hay dos opciones: `work` es un pulso sintetizado bajo,
mientras que `workLoop` reproduce el audio suministrado `333.wav`. Ambas se
repiten cada 5 segundos mientras haya al menos una sesión trabajando.

Cada evento tiene un botón **Preview** para escucharlo antes de guardar.

## Instalación

El plugin ya está instalado en el perfil `desktop` como dependencia local:

```json
"dsh-plugin-deepsound": "file:C:/Users/CBravo/Documents/deepseek-harness/Plug ins/Deepsound"
```

con `dsh-plugin-deepsound` añadido a `dsh.profile.bundles`.

Para instalarlo en otro perfil:

```powershell
dsh plugin --profile <perfil> add "C:\ruta\a\Deepsound"
```

O, desde la GUI: **Plugins → Add plugin → Install a third-party plugin** e
introduce la ruta del directorio.

Tras instalar, **reinicia DeepSeek Harness**: el plugin se monta al arrancar.

## Cómo funciona

### Mitad host — `lib/index.js`

Declara el esquema de configuración con Schemastery. El `id` de la fila en
`cordis.patch.yml` (`deepsound`) **es** el namespace de ajustes que edita el
cliente; el par de valores debe coincidir.

Todos los campos llevan `.volatile()`. Esto no es decorativo: el servicio de
ajustes solo proyecta un formulario desde campos con un ancestro volatile, y una
entrada cuyo esquema no proyecta nada **no recibe namespace** — la página nunca
aparecería.

### Mitad cliente — `lib/client.js`

Se sirve como bundle al navegador y se registra en
`window.__ModuleLoader__.load`.

Las señales de las que depende:

- **Fin de turno** — no existe un evento `turn/end`. Se deriva del store
  `ctx.uiSession.sessionStatus`, detectando el flanco `running: true → false`.
  Se exige una transición real para que cargar la página no suene.
- **Aprobaciones y preguntas** — `approval/request` y `user-questions/request`
  son *waterfalls* de Cordis. Este plugin **solo observa**: reproduce el sonido y
  delega con `return next()`. Devolver un valor lo convertiría en el respondedor
  y rompería los diálogos reales.
- **Errores, sesiones y goals** — eventos reenviados por el host vía
  `ctx.remote.$on`.

Los subagentes son sesiones normales; se distinguen por el campo `subagent` del
snapshot para darles su propio sonido.

### Detalles que importan

- El `AudioContext` se crea de forma perezosa y se desbloquea en el primer clic o
  pulsación de tecla, porque los navegadores exigen un gesto del usuario. Hasta
  entonces la página muestra un aviso.
- `play()` nunca lanza ni rechaza, así que es seguro llamarlo desde un waterfall.
- La reproducción se deduplica: dos señales iguales muy seguidas suenan una vez
  (evita el eco al reconectar, ya que los waterfalls pendientes se reenvían).
- Todas las suscripciones se registran con `ctx.effect`, así que desactivar el
  plugin las libera limpiamente.

## Desarrollo

```
Deepsound/
├── package.json          # manifiesto: dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # auto-activación; el id ES el namespace de ajustes
├── lib/
│   ├── index.js          # mitad host: esquema de configuración
│   └── client.js         # mitad navegador: motor de audio + página de ajustes
├── src/sound-engine.js   # fuente del motor (referencia legible)
└── _inspect/             # extracción del asar y arneses de prueba
```

El bundle `lib/client.js` está escrito a mano con el formato exacto del cargador
(no requiere compilación). Si editas `lib/client.js` con HMR activo, el navegador
recarga el plugin solo.

### Pruebas

```powershell
$node = "C:\Users\CBravo\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node _inspect\test-manifest.mjs      # manifiesto contra el parser real
& $node _inspect\test-node-half.mjs     # esquema + perfiles
& $node _inspect\test-settings-form.mjs # proyección volatile (namespace)
& $node _inspect\test-client.mjs        # bundle: slots, eventos, waterfalls
& $node _inspect\test-host-load.mjs     # carga como lo hace el host
```

`_inspect/CONTRACTS.md` documenta los contratos verificados del cliente (lista
blanca de eventos, algoritmo de fin de turno, primitivas de UI, tabla de módulos
compartidos) con referencias al código empaquetado.

## Limitaciones

- Los sonidos son sintetizados; no se pueden usar archivos de audio propios.
- El contexto de audio requiere un gesto del usuario: hasta el primer clic no
  suena nada (la página lo indica).
- Los eventos normales no se reenvían tras una reconexión, así que un sonido
  perdido durante una desconexión no se recupera.
- La configuración se guarda en el documento de ajustes del host, compartido
  entre navegadores autenticados.

## Desinstalación

```powershell
dsh plugin --profile desktop remove dsh-plugin-deepsound
```

Y quita `dsh-plugin-deepsound` de `dsh.profile.bundles` en el `package.json` del
perfil. Hay copias de seguridad de los archivos originales del perfil junto a
ellos, con el sufijo `.bak-deepsound`.
