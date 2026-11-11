# Dream Zone — tienda geek

Frontend estático (HTML/CSS/JS sin framework) + API en **Node.js** como **Vercel Functions** + **MongoDB** (Atlas).

En vivo: **https://dreamzonesh.com**

Diseño: **"Archivo de reliquias"**. Visor fijo a la izquierda y un índice editorial de piezas a la derecha (en móvil el visor es una hoja a pantalla completa). Usa Instrument Serif + IBM Plex Mono, en negro puro, y la copia en degradado desplazada del logo como firma.

**Color:** cada zona es una etiqueta de archivo de color (`--tone`). Las zonas las define la curaduría (nombre, color y orden; se pueden añadir y quitar) y la tienda genera las reglas `[data-zone="…"]` con sus colores. Ese color tiñe la pestaña y el relleno de su fila, el halo del visor, el eco de la pieza y el botón de compra. La curaduría puede darle a cada pieza un color propio. La rareza usa los colores clásicos del botín: común gris, poco común verde, rara azul, épica morada y legendaria naranja.

```
public/              → sitio estático (Vercel lo sirve desde la CDN)
  index.html         → la tienda
  cuenta.html        → credencial de jugador: entrar, registro, recuperar contraseña, perfil
  admin.html         → curaduría: editar toda la tienda (solo admins)
  css/styles.css     → tokens de diseño y estilos (tienda + cuenta)
  css/admin.css      → estilos de la curaduría
  js/main.js         → tienda: visor, índice, carrito, formularios, capa geek
  js/cuenta.js       → formularios de cuenta y la credencial holográfica
  js/progress.js     → logros y niveles (tienda + credencial): guardado, sincronización y notificaciones
  js/admin.js        → curaduría · Piezas: editor, subida de fotos y vista previa en vivo
  js/admin-modules.js→ curaduría · navegación y módulos Página, Drops, Pedidos, Buzón y Equipo
  pago.html, js/pago.js → pago: resumen del carrito, entrega, paso a Wompi y el resultado al volver
  js/vendor/, css/vendor/ → Leaflet 1.9.4 (BSD-2) para el plano de «Visítanos»; se carga solo al acercarse a la sección
  assets/img/        → logo (original y versión dark) + favicon
api/                 → una función serverless por archivo (11 en total; las rutas se agrupan por recurso para no multiplicarlas)
  auth/[action].js   → /api/auth/me · register · login · logout · forgot · reset · password · achievements · seen · profile · arcade
  admin/[resource].js→ /api/admin/products · site · drops · orders · inbox · team (solo admins)
  checkout/[action].js→ /api/checkout/quote · create · status · mine · conciliar · wompi (pagos)
  site.js            → textos, zonas y colores de la página (públicos)
  media.js           → imágenes de producto guardadas en Mongo
lib/                 → código compartido (Mongo, validación, HTTP, sesiones, correo, límites)
  site.js            → esquema del contenido editable, valores originales y validación
  achievements.js    → logros (id, XP, rareza), niveles y sus beneficios: la fuente de verdad del XP
  orders.js          → pedidos: cotización (precios, nivel, envío), creación y lo que pasa al aprobarse el pago
  wompi.js           → Wompi: firma de integridad, enlace de pago, consultas y verificación de avisos
  team.js            → invitaciones y permisos de la curaduría
  admin/             → un archivo por módulo de la curaduría
scripts/
  dev.js             → servidor local que imita a Vercel (rutas dinámicas incluidas, sin dependencias)
  seed.js            → índices + datos de ejemplo
  seed-data.js       → 15 piezas de prueba con precios en pesos y un drop
  make-admin.js      → da o quita permisos de curaduría (crea la invitación si la cuenta no existe)
  xp.js              → muestra o fija el XP extra de una credencial (npm run xp)
  simular-pago.js    → aprueba, rechaza o deshace un pedido sin cobrar, para probar la lógica (npm run pago:simular)
  probar-correo.js   → manda un correo de prueba y explica qué falla si el SMTP no funciona (npm run correo:probar -- tu@correo.com)
  cuentas-inactivas.js → avisa y borra las credenciales sin uso en 2 años, como dice la política de datos (npm run cuentas:inactivas)
vercel.json
```

### Cuentas (`/cuenta.html`)

- **Registro e inicio de sesión:** las contraseñas se guardan con scrypt (`node:crypto`). La sesión es un token aleatorio en una cookie `dz_session` (`HttpOnly; SameSite=Lax; Secure`), y Mongo guarda solo su SHA-256. Dura 30 días.
- **Recuperar contraseña:** `#recuperar` envía al correo un **código de 6 dígitos** (vence en 15 minutos, sirve una vez y aguanta 5 intentos; en la base solo queda su huella). En la misma ficha se escribe el código y la contraseña nueva: se cierran todas las sesiones y se entra. «Reenviar código» espera 60 s y cada correo admite 3 códigos por hora. La respuesta es la misma exista o no la cuenta. Sin SMTP configurado, en local el código se imprime en la consola de `npm run dev`. (Las invitaciones de la curaduría siguen con su enlace de activación.)
- **Perfil:** datos de la credencial, nivel y XP, cambio de contraseña (cierra las otras sesiones) y cierre de sesión. Los logros, con su fecha, van debajo de la tarjeta.
- **Borrar credencial** (ficha 08, `POST /api/auth/delete`), con **tres verificaciones**: 1) la contraseña; 2) un código de 6 dígitos que llega al correo (15 min, 5 intentos, igual que el de recuperar); 3) escribir BORRAR. Se borran la cuenta (logros, XP, nivel), sus sesiones y códigos; los pedidos se quedan sin el enlace a la cuenta (`accountDeletedAt`), como pide la ley contable. Una casilla (marcada) la saca también de la lista de drops. La última cuenta activa de la curaduría no se puede borrar.
- **Editar credencial:** nombre, **apodo** (opcional, 2–24 caracteres: letras, números, espacios y `. _ - '`) y **color del cuadro** con la inicial (el del nivel, 9 colores fijos, *Holo*, una lámina tornasol de carta holográfica que solo se puede elegir en Mítico, o *DZ pixelado*, las letras DZ en la fuente de los cuadros sobre un tramado pixel fijo de los azules del logo (como el de Adepto), que no pide nivel sino el logro secreto Viejo truco y mientras tanto sale bloqueado como «logro secreto»; si la cuenta baja de nivel vuelve al color del nivel). La tarjeta muestra los cambios mientras se escriben. El apodo va en grande en la credencial y en la barra de la tienda, con el nombre debajo; los nombres largos se achican y nunca tapan el sello.
- **Protección:** límite de intentos guardado en Mongo (8 inicios fallidos por correo cada 15 min, 3 enlaces por correo cada hora), comprobación de `Origin` en todas las mutaciones y una lista de contraseñas demasiado comunes.

### Niveles y logros

| Nivel | XP | Cómo se llega |
|-------|----|---------------|
| Lv 01 · Novato | 0 | Al crear la credencial. |
| Lv 02 · Adepto | 500 | **Completando los 12 logros**: entre todos suman exactamente 500 XP. |
| Lv 03 · Leyenda | 2,000 | XP del arcade diario, compras (5 XP por cada $1.000) o `npm run xp`. |
| Lv 04 · Mítico | 5,000 | Igual que Leyenda. |

**Beneficios al pagar** (se acumulan; `LEVEL_PERKS` en `lib/achievements.js`, copia en `progress.js`): **Adepto** 5% en todas las piezas · **Leyenda** además 10% en todos los drops · **Mítico** además envío gratis desde $50.000 en productos. Los aplica el servidor al cotizar; la tienda los muestra bajo el precio, en los drops y en el carrito.

- **Fuente de verdad:** `lib/achievements.js` (ids, XP y rareza de cada logro, umbrales de nivel). `public/js/progress.js` lleva una copia y la lógica que desbloquea cada logro; si cambias uno, cambia el otro.
- **Dónde se guardan:** con sesión, en la cuenta (`users.achievements`, fecha del primer desbloqueo) y el servidor calcula XP y nivel. Sin sesión, en `localStorage`; al entrar o registrarse pasan a la credencial.
- **Registro de vistas:** también es de la credencial (`users.seen`), así vale en cualquier dispositivo. *Primer vistazo* (1) y *Archivo completo* (todas las piezas del índice, las 48 más nuevas) los otorga el servidor a partir de ese registro (`seenAchievements` en `lib/achievements.js`). Sin sesión se lleva en el navegador y pasa a la cuenta al entrar. Una pieza queda vista tras 0,65 s en el visor; volver a elegir la misma no reinicia la cuenta.
- **Dónde se ve el nivel:** el color del cuadro con la inicial en la barra (con una barrita de XP hacia el siguiente nivel), la credencial de `cuenta.html` (franja, nivel, barra de XP) y la escalera de *Niveles*, que marca el tuyo. **Mítico** usa el degradado del logo corriendo sin parar hacia la derecha, como la ola de un teclado RGB (`--flow` + animación `wave` en `styles.css`; `--wave-w` y `--wave-t` fijan el largo y la velocidad de la ola): en el cuadro (con destello y halo), en el marco, la franja y el nombre de la credencial, y en la escalera.
- **Notificaciones:** cada logro nuevo sube una tarjeta en la esquina inferior derecha (trofeo con el color de su rareza, XP y conteo), como en Steam; al subir de nivel sale otra con el nivel nuevo y su beneficio. Se cierran solas, con un clic, y se quedan mientras el cursor está encima.
- **Arcade:** al final de la página hay una máquina con tres juegos: **Breakout**, **Snake** y **Pac-Man**. Antes de cada moneda se elige el juego. Hay una moneda al día (hora de Bogotá) y cada partida da de 1 a 50 XP según el puntaje: Breakout 5 por cada 4 ladrillos, Snake 5 por cada 3 manzanas y Pac-Man 5 por cada 25 de los 251 puntos del laberinto (`ARCADE_GAMES` en `lib/achievements.js`). Los 50 se alcanzan limpiando los 40 ladrillos, con 30 manzanas o con el laberinto completo. Los juegos se dibujan en pixel art: una pantalla de 192 × 126 píxeles que se amplía por un entero sin suavizar (con scanlines suaves de CRT), y Pac-Man y los fantasmas son sprites de 7 × 7. Los ladrillos, las manzanas y los fantasmas usan los colores de las zonas. El sprite del logo queda solo para el código Konami. La moneda se gasta al insertarla (`POST /api/auth/arcade { step: 'start', game }`) y el XP se suma una sola vez al terminar (`{ step: 'finish', score }`), en `users.arcadeXp`. **La curaduría tiene monedas ilimitadas:** su primera partida del día suma XP y las demás son libres, sin XP. Sin credencial se juega igual, pero no suma.
- **XP extra:** `npm run xp -- correo@ejemplo.com 5000` lo fija (se suma al de los logros); sin número muestra el XP, el nivel y los logros de la cuenta; con `0` lo quita.
- **XP de compras:** cada pedido pagado con credencial suma 5 XP por cada $1.000 completos en productos (sin el envío), en `users.purchaseXp`.
- **Ojo con Adepto:** los logros se desbloquean en el navegador y el servidor solo valida que el id exista, así que alguien con conocimientos técnicos podría reclamarlos por la API y llegar a Adepto (5% de descuento). Leyenda y Mítico no se pueden falsear así: piden XP de compras verificadas por Wompi o del arcade (máximo 10 al día).

### Curaduría (`/admin.html`)

Cinco módulos, cada uno con su color y su dirección (`/admin.html#pagina`, `#drops`…):

| Módulo | Qué se edita |
|--------|--------------|
| **01 Piezas** | El catálogo completo (detalle abajo). |
| **02 Página** | Todos los textos de la tienda: título y descripción para Google, portada y datos rápidos (`{piezas}` y `{zonas}` se cuentan solos; `{horario}` muestra el horario de hoy de la tienda, festivos incluidos), **zonas** (nombre, color y orden; se añaden y se quitan; una zona con piezas no se puede quitar hasta pasarlas a otra), drops (títulos), arcade, títulos y subtítulos de las secciones (también los del menú), niveles (nombre y beneficio; el XP lo fija la tienda), logros (nombre, descripción y, en los secretos, la pista que se ve antes de desbloquearlos), encargos, **Visítanos** (dirección, referencia, pago, horario por día y coordenadas del mapa), correo, carrito, mensajes de “vacío” y de éxito, el pie de página con sus enlaces (redes, ayuda, privacidad) y la **política de privacidad** (razón social del responsable, NIT o cédula, correo de servicio al cliente, teléfono y proveedor de factura electrónica; «Por definir» deja el texto genérico u oculta la línea del documento). Tiene **vista previa en vivo** de la tienda (escritorio o móvil) que salta a la sección que editas, y un botón para restaurar los textos originales de cada sección. `*palabra*` resalta una palabra con el eco de color. |
| **03 Drops** | Armar bundles: nombre, número, descripción, de 2 a 6 piezas del catálogo (casillas con filtro y la suma de sus precios), precio del drop (siempre menor que esa suma), cierre, si está activo y si **se avisa por correo** a los suscriptores al publicarlo. La vista previa dice cuántos drops alcanzan y qué pieza manda, avisa si una pieza está sin publicar o agotada y muestra el aviso por correo: cuántos suscriptores lo recibirán, cómo va el envío o cuándo salió, con «Avisar ahora» / «Reanudar aviso». |
| **04 Pedidos** | Los pagos de Wompi: por despachar · pagados · esperando pago · rechazados. Arriba, un **buscador** (referencia, cliente, correo, celular, documento, ciudad, guía o pieza, sin importar tildes; atajo `/`) y el **orden** (más recientes, más antiguos, mayor o menor total). La búsqueda, los conteos de cada pestaña y las páginas (de 24) los resuelve el servidor, así que sirve igual con miles de pedidos. Cada pedido trae lo comprado, el total, el beneficio de nivel, la entrega, el contacto, el documento y la transacción de Wompi. Dos estados: **Pagado** (por despachar) y **Enviado**. Para marcarlo enviado hay que elegir la **distribuidora** (Servientrega, Interrapidísimo, Coordinadora, Envía, TCC, Deprisa, 4-72 u otra, con su nombre) y escribir el **número de guía**; sin eso no sale. Quien compró lo ve en «Mis pedidos» y en su recibo, con un botón para copiar la guía y el enlace a la página de la distribuidora, y si hay SMTP le llega un correo. Lo que se recoge en la tienda se marca **listo para recoger** sin guía: a quien compró le llega un correo con la dirección, la referencia de la sala y el horario (de «Visítanos»), y su pedido dice «Listo para recoger». «Deshacer» (dos clics) lo devuelve a por despachar; «Corregir guía» no cambia la fecha de salida. La pestaña avisa cuántos hay por despachar. |
| **05 Buzón** | Las fichas de encargo (con estado nuevo · cotizado · cerrado y botón para responder por **WhatsApp** con un mensaje que ya trae la ficha y la pieza) y los suscriptores (copiar correos o descargar CSV). La pestaña avisa cuántas fichas nuevas hay. |
| **06 Equipo** | Quién es admin. **Dar acceso** a un correo: si ya tiene credencial, entra al instante; si no, se crea una invitación con un enlace de activación (un solo uso, 7 días) que se copia desde el panel y, si hay SMTP, también llega por correo. También: enlace nuevo, cancelar invitación y quitar acceso (nadie puede quitarse el acceso a sí mismo). |

Todo se valida dos veces (navegador y servidor), los enlaces solo aceptan `https://`, `mailto:`, `tel:`, `#seccion` o `pagina.html`, y si dos personas editan lo mismo, la segunda en guardar recibe un aviso en lugar de pisar el trabajo de la otra.

**Piezas:** se puede editar todo lo de una pieza: nombre, formato, zona, slug, SKU, precio, precio anterior, etiqueta, existencias (en total o **por talla**: XS a XXL), rareza, color, ilustración, lore, fotos (hasta 8, reordenables, la primera es la portada), estado (activa · borrador · archivada) y fecha de alta. También se pueden crear, duplicar y eliminar piezas.

- **Fotos:** `js/photo.js` las encuadra en el navegador antes de subirlas: recorta el margen transparente de un recorte (o el fondo liso de una foto de estudio) al contorno de la pieza, le deja 5 % de aire en cada lado y la lleva a WebP ≤ 1600 px, así todas se ven del mismo tamaño en el visor, los drops y las miniaturas. Una foto con escenario no se recorta. Se guardan en la colección `media`. Se sirven con caché inmutable, así que la CDN de Vercel las entrega sin tocar Mongo. Un PNG recortado (con fondo transparente) se muestra en el visor con su silueta repetida en el color de la pieza. **En el visor** (y en la vista previa de la curaduría) cada foto se muestra recortada a su contorno en el navegador (`DZPhoto.trimmed`, una vez por foto, también para las subidas antes del encuadre) dentro de un marco cuadrado del mismo tamaño para todas las piezas, que depende solo de la pantalla, con 6 % de aire para el eco; si la ficha es más larga (pieza en un drop) es la ficha la que se desplaza. **Zoom:** «zoom +» o un clic en la foto la amplía ×2.5 dentro del visor; con ratón la lupa sigue al cursor y la rueda cambia el aumento (×1.5 a ×4), con el dedo se arrastra y se pellizca, con teclado flechas y + / −; Esc, el botón o un clic salen.
- **Cambiar el slug** actualiza los carritos y los drops que lo usan. No se puede borrar una pieza que está en un drop activo (quítala del drop o archívala). **Borrar una pieza o un drop** lo saca también de los carritos de la gente (el aviso dice de cuántos), y cada carrito se limpia solo al leerse (`pruneCart` en `lib/cart-session.js`) de líneas de piezas o drops que ya no existen, con un aviso a quien compra. Una pieza agotada o archivada que siga en un carrito sale en rojo («agotado» / «no disponible») y no suma al total.
- **Etiqueta «Nuevo»:** dura un mes desde la fecha de alta (`shownBadge` en `lib/catalog.js`); después la tienda muestra la pieza sin etiqueta, sin tocar lo guardado. El editor dice hasta cuándo se verá o que ya venció (cambiar la fecha de alta la vuelve a destacar).
- **Compra en la sala (Pedidos › «+ Compra en la sala»):** se escribe el correo de la credencial (el panel muestra a quién pertenece, su nivel y XP), el valor de la compra y una nota opcional; antes de sumar, un cuadro de confirmación repite a quién, cuánto y cuánto XP (de cuánto a cuánto) y solo «Sí, sumar» lo envía (cambiar un dato, «Corregir» o Esc lo cierran); se suma el XP como una compra en línea (5 XP por cada $1.000, `purchaseXp`) y le llega un correo de gracias con lo que sumó y su nivel. Cada compra queda en `store_sales` (quién la registró, valor, XP, si salió el gracias) con «Deshacer», que resta su XP sin bajar de 0. Una clave por formulario evita sumarla dos veces. `lib/admin/sala.js` · `/api/admin/sala`.
- **Agotado en rojo:** etiqueta roja a trazos en el índice y el buscador (reemplaza a Nuevo/Oferta), «Agotado» en rojo en la ficha y botones de compra rojos (también «Drop agotado» y «Sin existencias»).
- **Sin preventa:** todo se vende con existencias; con 0 unidades la pieza se muestra agotada.
- Si dos personas editan la misma pieza, la segunda en guardar recibe un aviso en lugar de pisar el trabajo de la otra.
- **Atajos:** `Ctrl/⌘ S` guardar, `N` nueva pieza, `/` buscar, `Esc` cerrar. La vista previa muestra el visor y la fila del índice en vivo.
- Los cambios llegan a la tienda en segundos: el catálogo (con las existencias) se cachea 10 s en la CDN y los textos (`/api/site`) 60 s.

**Dar acceso:** desde el módulo **Equipo**, o en la terminal con `npm run admin -- correo@ejemplo.com`.
Si la cuenta no existe, el comando crea la invitación e imprime el enlace de activación (usa `APP_URL` o `http://localhost:3000`; cámbiale el dominio si lo abres en producción).
Para quitarlo: `npm run admin -- correo@ejemplo.com --quitar` (en una invitación pendiente, la cancela).

### Visítanos (la tienda física)

Sección `#visita`: dirección en grande, botones **Cómo llegar** (Google Maps) y **Waze**, estado en vivo calculado con la hora de Bogotá (“Abierto ahora · cierra a las 20:00” / “Cerrado · abre mañana a las 11:00”), horario agrupado por días con el de hoy marcado, y un plano interactivo: tiles de OpenStreetMap en gris invertido para vivir en negro, con el logo clavado sobre el local. En el celular un dedo mueve la página y dos hacen zoom; sin JavaScript queda un enlace a Google Maps. La misma información se publica como ficha `Store` de schema.org para los buscadores.

### Drops (bundles)

Un drop junta de 2 a 6 piezas del catálogo en un bundle de edición limitada con precio menor que la suma de sus precios. Se arman en Curaduría › Drops.

- **En la tienda:** la sección `#drops` (debajo del índice) muestra todos los drops activos, del que cierra antes al que cierra después. Cada uno trae su cuenta regresiva, sus piezas (clic → al visor), el precio por separado tachado, el del drop, el ahorro y **cuántos drops quedan**: los que permite la pieza con menos existencias (3 piezas con 4, 5 y 6 → 4). No hay un cupo aparte: cada drop pagado descuenta una unidad de cada pieza, y si una se agota el drop sale «Drop agotado» en rojo.
- **En cada pieza:** las filas del índice llevan la etiqueta **Drop** y la ficha del visor explica con qué se lleva, cuánto cuesta el bundle y cuánto se ahorra, con botón para añadirlo.
- **Carrito:** el bundle entra como una línea propia (con sus piezas). Las existencias de cada pieza cuentan lo que ya hay en el carrito, suelto o dentro de bundles. Si el drop cierra, su línea queda marcada como cerrada y fuera del total.
- Un drop con alguna pieza sin publicar no se muestra. Si una pieza está agotada, el drop se ve pero no se puede añadir.
- **Aviso por correo a la lista:** con «Avisar por correo a los suscriptores» encendido (viene así; apagado no sale ningún correo hasta pulsar «Avisar ahora»), la primera vez que se guarda un drop **activo y abierto**, a cada suscriptor le llega un correo con el drop (piezas, precio, ahorro, unidades y cierre) y su enlace para darse de baja (también en la cabecera `List-Unsubscribe`, con baja de un clic). Cada drop se avisa una sola vez y a nadie le llega dos veces; si el envío se corta (límite de tiempo de la función) o algo falla, «Reanudar aviso» sigue con quienes faltan. Un drop pausado o cerrado no se avisa. Necesita SMTP; con Gmail el límite es de unos 500 correos al día.

### Pagos con Wompi

El carrito lleva a `pago.html`: resumen del pedido como recibo (con el beneficio de nivel y el envío), datos del comprador (nombre, correo, celular, documento) y entrega (**envío a domicilio** con departamento, ciudad y dirección, o **recoger en la tienda** gratis). Al pagar, el servidor recalcula todo con los precios de la base, crea el pedido (`DZaammdd-XXXXXX`) y manda a la página segura de Wompi (Web Checkout) con el monto firmado y los datos ya llenos: tarjeta, PSE, Nequi, Daviplata, botón y QR Bancolombia, según lo que tenga activo el comercio. Los datos de pago nunca pasan por Dream Zone.

- **Al volver** (`pago.html?ref=…&k=…&id=…`) la página muestra el resultado con su sello: **pagado** (con el XP ganado), **en proceso** (se consulta sola cada 3 s; PSE puede tardar) o **rechazado** (no se cobra y el carrito sigue intacto). La llave `k` abre el pedido sin sesión; con sesión, cada quien ve los suyos en `cuenta.html#pedidos`.
- **Cómo se confirma:** por el aviso de Wompi (`POST /api/checkout/wompi`: verificado con el secreto de eventos y, además, contrastado con la API de Wompi, así un aviso falso no aprueba nada) Nunca depende de que quien compra vuelva a la tienda (en el celular Wompi no siempre ofrece volver): si el aviso no llega, **Vercel Cron** llama a `/api/checkout/conciliar` cada 5 minutos y pregunta a Wompi por los pedidos sin resolver de la última semana, y también se pregunta al abrir el recibo, «Mis pedidos» o la tienda desde el navegador donde se abrió Wompi (que lleva al recibo si ya se aprobó). Toda consulta a Wompi usa la llave privada: sin ella responde 404 aunque la transacción exista. Un pedido solo se resuelve una vez, aunque lleguen el aviso y la consulta a la vez; la excepción es un **reintento**: Wompi deja volver a pagar un rechazo con la misma referencia durante 3 minutos, así que un aprobado manda sobre un rechazo, nunca al revés. Si el monto pagado no coincide con el pedido queda en *error* y no se entrega.
- **Al aprobarse:** se descuentan las existencias (también las de cada pieza de un drop), lo comprado sale del carrito, la credencial suma su XP y, si hay SMTP, llega un correo de confirmación a quien compró y otro a **toda la curaduría** («Nuevo pedido», con lo comprado, el cliente y la entrega; cada uno sale una sola vez). Si otra compra se llevó la última unidad a la vez, el pedido se marca para revisión en Curaduría › Pedidos.
- **Envío cotizado en vivo con Envia.com** (`lib/shipping.js`, con `ENVIA_API_KEY`): la tienda despacha todo con **Interrapidísimo**, así que al escribir la ciudad la página de pago le pide la tarifa (máximo 7 s) y la muestra con su tiempo de entrega. Para cotizar también con otras (Coordinadora, Servientrega, Mensajeros Urbanos…) basta sumarlas en `SHIPPING_CARRIERS`: el pago las lista, marca la más barata y quien compra elige. El servidor vuelve a cotizar al crear el pedido (nunca se confía en el precio del navegador) y guarda con qué transportadora se cotizó y cuánto cobra (`shippingQuote`); la curaduría lo ve en el pedido y el despacho ya trae esa distribuidora elegida. Detalles:
  - **El municipio es obligatorio y tiene que existir:** se busca en la lista oficial del DANE (`lib/municipios.js`, 1.122 municipios generados de DIVIPOLA en datos.gov.co; el pago la muestra como desplegable, igual que el departamento, con `GET /api/checkout/places`). Vale el nombre oficial o su forma corta («Cali», «Cúcuta», «Cartagena»), sin importar tildes ni mayúsculas; en Bogotá D.C. vale cualquier localidad. Si no está, el pago muestra el aviso en rojo con hasta 3 sugerencias de un clic («medelin» → Medellín) y **no deja pagar**; el servidor también lo rechaza (409). El pedido guarda el nombre oficial y el código DANE (`delivery.cityCode`), que es el que se cotiza con Envia (+ «000»). El código postal no cambia el precio en Colombia.
  - El precio depende del **peso de las piezas** (cada una tiene «Peso de la pieza» en Piezas › Existencias; sin él, el peso por pieza de Pago y envíos, 400 g; el empaque no se cuenta) y de la **caja**, que se elige según el peso (de 20×15×10 hasta 50×40×30 cm), porque las transportadoras cobran por volumen.
  - Las cotizaciones se guardan 6 h (`shipping_cache`, con TTL). Si Envia no responde o Interrapidísimo no llega a ese municipio, el pago no sigue y se ofrece recoger en la tienda (con envío gratis sí sigue: la tienda paga y cotiza el despacho después). Las tarifas fijas de Pago y envíos solo rigen sin `ENVIA_API_KEY` (pruebas locales).
  - El envío gratis (Mítico desde $50.000 o la promoción) sigue igual: no se elige transportadora, la tienda paga la más barata. «Recargo sobre la cotización» suma un monto fijo a lo que cobra la transportadora.
  - Solo se cotiza: **no se generan guías** (eso sí tiene costo en Envia). La guía se sigue escribiendo al despachar.
- **Tarifas fijas** (Curaduría › Página › *Pago y envíos*), el respaldo cuando no hay cotización en vivo: Bogotá ($9.000), resto del país ($16.000), envío gratis para todos desde un monto (0 = nunca), tiempos de entrega y texto de recoger en tienda. El pago mínimo es $1.500.
- **El carrito** permite cambiar unidades (− / +, máximo 5) y quitar piezas.
- **Tallas:** una pieza puede venderse por tallas (Curaduría › Piezas › Existencias › *Se vende por tallas*). Cada talla lleva sus unidades y el stock de la pieza es la suma; una talla en 0 se ve tachada y las vacías no aparecen. En la tienda el botón espera a que se elija la talla (el «+» de la fila abre el visor para elegirla), cada talla es una línea propia del carrito y al pagar se descuenta de la talla comprada. Las piezas con tallas aún no pueden ir en un drop.
- **Configurar el aviso de Wompi:** en el panel de Wompi › Desarrolladores › *URL de eventos* de **producción** pon `https://TU-DOMINIO/api/checkout/wompi`, sin `www` (ese dominio redirige y el aviso se pierde). Para comprobarlo después de un pago: `vercel logs requests --since 1h --query 'requestPath:"/api/checkout/wompi"'` debe mostrar un 200 (un 401 es secreto de eventos distinto; sin filas, la URL del panel está mal).
- **Conciliación automática:** en Vercel define `CRON_SECRET` (cualquier cadena larga al azar); sin él, `/api/checkout/conciliar` responde 401 y no corre. `npm run pago:conciliar` hace lo mismo a mano y sin el límite de una semana.
- **En local** Wompi no deja volver a `http://localhost` (su cortafuegos lo bloquea), así que el enlace de pago solo lleva la dirección de regreso cuando es HTTPS; prueba el ciclo completo en Vercel. Con llaves de producción cada pago es real: para probar usa las de sandbox (`pub_test_…`, `prv_test_…`, `test_integrity_…`, `test_events_…`).
- **Probar sin pagar:** crea un pedido en `pago.html` (llega a Wompi y vuelve sin pagar) y simula lo que respondería Wompi:
  `npm run pago:simular` lista los pedidos pendientes; `npm run pago:simular -- DZ261016-ABC123` lo aprueba (también `rechazado`, `anulado`, `error` o `proceso`) y `… deshacer` lo borra devolviendo existencias y XP. Usa el mismo camino que el aviso real (`applyTransaction`), así que se ve todo: existencias por talla, carrito, XP, Mis pedidos y Curaduría › Pedidos, donde el pedido sale marcado **simulado** para no despacharlo. Ojo: cambia las existencias reales de la base hasta que lo deshagas.
- **Recibos de demostración:** `npm run pago:simular -- recibos correo@ejemplo.com 15` crea 15 recibos pagados en esa credencial (con precios, beneficio de nivel y envío reales, repartidos en los últimos meses: los 2 más nuevos por despachar y el resto enviados con su guía o listos para recoger en la tienda) **sin tocar existencias, carrito ni XP**, para ver cómo se acumulan. En la curaduría salen marcados «demostración». `… recibos correo@ejemplo.com borrar` los quita.

### Capa geek (todo en el frontend, sin costo de API)

| Qué | Cómo se usa |
|-----|-------------|
| Visor | Al abrir la página muestra un visor en espera: una mira en pixel art de 32 × 32 con los azules del logo (esquinas que enfocan a saltos, línea de escaneo y punto central que parpadea), dibujada en `index.html` y animada en `styles.css`. Una pieza aparece al hacer clic (o Enter) en su fila, o al recorrer el índice con `↑ ↓`; pasar el ratón por el índice no lo cambia. En móvil el clic abre la hoja del visor. |
| Registro de piezas | Cada pieza que abres en el visor y miras ≥ 0,65 s queda **vista**; las que están en el carrito se marcan **en el carrito**. Con sesión se guarda en la credencial; sin sesión, en `localStorage`. |
| Carrito | Se llama *Carrito* (antes *Inventario*, que confundía a la clientela) y muestra los slots usados (máx. 30, igual que la API). |
| Logros | 12 logros (2 secretos, que muestran una pista mientras siguen ocultos) con XP en la sección *Niveles*; completarlos todos sube a Adepto. Ver *Niveles y logros*. |
| Terminal | `Ctrl/⌘ K` o `:` → comandos: `ir <sección>` (índice, drops, niveles, logros, encargos, visita, correo, arcade), `zona <nombre>`, `buscar <texto>`, `ver <nº o nombre>`, `azar` (1d20), `carrito`, `cuenta`, `pedidos`, `modo arcade` (scanlines y 8 bits), `ayuda`; `curaduria` solo aparece con una credencial de la curaduría. Los ejemplos de `zona` y `ver` salen de las zonas y piezas reales. |
| Páginas | El índice muestra 10 piezas por página dentro de la zona elegida; con más aparece «← Anterior · 01 02 … · Siguiente →». El buscador busca en todo el archivo (no solo en la página) y la terminal `ver <nº>` encuentra piezas de cualquier página. |
| Teclado | `↑ ↓` o `j k` (`j` sube, `k` baja) recorren el índice (el visor los sigue), `/` filtra, `Esc` cierra paneles. |
| Inspección | Mover el ratón sobre el visor gira la pieza en 3D y desplaza su copia en degradado. |
| Ambientación | Cada producto tiene `lore` (campo en Mongo) que el visor muestra como texto de carta. |
| Código Konami | ↑↑↓↓←→←→BA activa el modo arcade (scanlines + tipografía de 8 bits) y revela la entrada 0000: el logo en sprite de 32 × 32 (`assets/img/dz-sprite.png`), ampliado sin suavizar, con rareza **Mítica**: seis teclas que recorre la ola del degradado. Se queda en el visor hasta que eliges otra pieza. |
| 404 | `public/404.html` (Vercel lo sirve solo): “tirada fallida”. Para verla en local abre cualquier ruta que no exista, como `http://localhost:3000/no-existe`. |
| Privacidad | `public/privacidad.html`: política de tratamiento de datos, versión 1.1 (Ley 1581 de 2012 y Decreto 1074 de 2015), revisada con las observaciones del abogado (la 1.1 solo quitó la nota opcional del pedido, que ya no se pide): responsable, qué se recoge y para qué, encargados (transmisión) y responsables independientes (transferencia) con su país, plazos de conservación, derechos del artículo 8, consultas y reclamos con los plazos de la ley, autorización, menores, incidentes y cambios. Los datos del responsable se editan en Curaduría › Página › Política de privacidad (`js/privacidad.js` los trae de `/api/site`); domicilio y dirección salen de «Visítanos»; versión y fecha van con el texto. **Autorización:** registro, pago, ficha de encargo y lista de drops tienen la casilla «Leí y acepto…» (también declara mayoría de edad o permiso); sin ella el servidor responde 400, y con ella guarda `consent: { policy, at }` en el usuario, el pedido, la ficha o el suscriptor (`lib/privacy.js`, `POLICY_VERSION`: súbela si cambia el texto). Las fichas de encargo sin novedad en 6 meses se borran solas. |

## Requisitos

- Node.js 24
- Un cluster de MongoDB Atlas (el plan gratuito M0 alcanza)
- Una cuenta de Vercel para publicar

## Correr en local

```bash
npm install
cp .env.example .env      # en Windows: copy .env.example .env  → pon tu MONGODB_URI
npm run seed              # crea índices y carga los datos de ejemplo
npm run dev               # http://localhost:3000 (se reinicia al guardar)
```

`npm run seed` crea los índices e inserta solo lo que falte: **nunca pisa piezas editadas en la curaduría**.
`npm run seed:fresh` vacía y recrea productos (con sus imágenes) y el drop. Es útil cuando el drop de ejemplo ya cerró, pero
**también borra las piezas creadas en la curaduría**. Nunca borra cuentas, carritos, suscriptores ni pedidos especiales.

Primer admin: `npm run admin -- tu@correo.com` y abre el enlace de activación que imprime (o, si ya te registraste en `/cuenta.html#registro`, el comando te da acceso directo).

Comprobar la conexión: `http://localhost:3000/api/health`.

## API

| Método | Ruta                   | Qué hace |
|--------|------------------------|----------|
| GET    | `/api/catalog`         | Una página de piezas (las más nuevas primero) + `page`, `pages`, `matched` y el conteo por zona. Query: `category` (clave de una zona), `q` (nombre, SKU o formato; sin importar mayúsculas ni tildes), `page`, `limit` (1–48, la tienda usa 10), `index=1` (suma los slugs de las 48 más nuevas, base de los logros de vistas) |
| GET    | `/api/drops`           | Drops activos (bundles) con sus piezas, precio normal, precio del drop, cuántos alcanzan (`available`: la pieza con menos existencias) y cierre |
| GET    | `/api/cart`            | Carrito del visitante (cookie `dz_cart`) |
| POST   | `/api/cart`            | `{ productId, qty? }` añade una pieza · `{ dropCode, qty? }` añade el bundle de un drop activo si alcanzan las existencias de sus piezas |
| PATCH  | `/api/cart`            | `{ productId, qty }` o `{ dropCode, qty }` fija las unidades de una línea (0 la quita) |
| GET    | `/api/checkout/quote`  | Cotización del carrito: líneas con el beneficio de nivel, envío (`method=envio` o `tienda`, `region`) y total |
| POST   | `/api/checkout/create` | `{ customer, delivery, consent }` → crea el pedido y devuelve el enlace firmado a Wompi |
| GET    | `/api/checkout/status` | `?ref=&k=&id=` → estado del pedido (consulta a Wompi si sigue pendiente). Pendiente con `paymentStarted: false` y `checked: true` = salió de Wompi sin pagar |
| GET    | `/api/checkout/mine`   | `?page=` → pedidos **pagados** de la credencial con sesión, de 5 en 5, con el total, el XP y las páginas. «Mis pedidos» los muestra plegados (qué, cuándo, cuánto y si va Pagado o Enviado); desplegados, la distribuidora, la guía y cada pieza |
| GET    | `/api/checkout/conciliar` | Vercel Cron, cada 5 min (`Authorization: Bearer $CRON_SECRET`): resuelve con Wompi los pedidos abiertos de la última semana |
| POST   | `/api/checkout/wompi`  | Aviso de Wompi (eventos `transaction.updated`, firma verificada) |

| POST   | `/api/subscribe`       | `{ email }` — lista de drops (idempotente, con honeypot anti-bots) |
| GET · POST | `/api/subscribe?baja=<token>` | Baja de la lista: el enlace de cada correo (GET, vuelve a la tienda con un aviso) o el botón del cliente de correo (POST) |
| POST   | `/api/special-orders`  | `{ piece, whatsapp }` — encargo; el WhatsApp es un celular colombiano (con o sin +57). Devuelve un código `DZ-XXXXXX` |
| GET    | `/api/site`            | Textos, zonas y colores de la página (lo que edita el módulo Página) |
| GET    | `/api/health`          | Ping a MongoDB |
| GET    | `/api/auth/me`         | Usuario de la sesión o `null` |
| POST   | `/api/auth/register`   | `{ name, email, password }` — crea la cuenta y abre sesión |
| POST   | `/api/auth/login`      | `{ email, password }` |
| POST   | `/api/auth/logout`     | Cierra la sesión actual |
| POST   | `/api/auth/forgot`     | `{ email }` — envía un código de 6 dígitos al correo (misma respuesta exista o no) |
| POST   | `/api/auth/reset`      | `{ email, code, password }` — contraseña nueva con el código; o `{ token, password, name? }` para activar una invitación. Cierra todas las sesiones y abre una |
| POST   | `/api/auth/password`   | `{ current, password }` con sesión — cambia la contraseña |
| POST   | `/api/auth/seen`       | `{ ids }` con sesión — suma piezas (slugs, máx. 48) al registro de vistas y otorga los logros de vistas; `[]` solo los revisa |
| POST   | `/api/auth/profile`    | `{ name, nickname?, avatarColor? }` con sesión — edita nombre, apodo y color del cuadro |
| POST   | `/api/auth/achievements` | `{ ids }` con sesión — suma logros a la credencial; devuelve `{ user, unlocked }` (XP y nivel recalculados, y cuáles son nuevos) |
| GET    | `/api/admin/products`  | **Admin.** Todas las piezas, en cualquier estado |
| POST   | `/api/admin/products`  | **Admin.** Alta de pieza |
| PUT    | `/api/admin/products?id=` | **Admin.** Edición completa (con bloqueo optimista vía `updatedAt`) |
| DELETE | `/api/admin/products?id=` | **Admin.** Baja definitiva y sus imágenes |
| GET · PUT | `/api/admin/site`   | **Admin.** Contenido de la página con su esquema y valores originales · `{ site, updatedAt }` guarda todo |
| GET · POST · PUT · DELETE | `/api/admin/drops[?id=]` | **Admin.** Drops |

| GET · PUT · DELETE | `/api/admin/inbox[?kind=order\|subscriber&id=]` | **Admin.** Fichas de encargo (estado) y suscriptores; `?summary=1` solo cuenta |
| GET · POST · PUT · DELETE | `/api/admin/team[?id=]` | **Admin.** Equipo: `{ email, name? }` da acceso o invita · `?id=&action=link` enlace nuevo · `{ role }` quita el acceso · DELETE cancela una invitación |
| GET    | `/api/media?id=`       | Imagen de producto (caché inmutable) |
| POST   | `/api/media`           | **Admin.** `{ data: base64, cutout }` — JPG, PNG o WebP de hasta 2.5 MB |
| DELETE | `/api/media?id=`       | **Admin.** Borra una subida que aún no se guardó en ninguna pieza |

Los errores siempre responden `{ "error": "mensaje" }` con el código HTTP adecuado (400, 401, 403, 404, 405, 409, 413, 415, 429, 503).

## Colecciones en MongoDB

| Colección        | Contenido | Índices |
|------------------|-----------|---------|
| `products`       | catálogo (precios en centavos; `sizes` = [{ size, stock }] si va por tallas) | `slug` y `sku` únicos; `status + category + createdAt` |
| `drops`          | bundles: `title`, `items` (slugs), `priceCents`, `total`, `claimed`, `endsAt`, `active` | `code` único; `active + endsAt`; `items + active` |

| `carts`          | carritos anónimos (`_id` = UUID de la cookie) | TTL de 30 días sobre `updatedAt` |
| `orders`         | pedidos: comprador, entrega, líneas con su descuento, totales, estado del pago (`pending`, `approved`, `declined`, `voided`, `error`), transacción de Wompi, entrega (`fulfillment`, `tracking`) y XP | `reference` único; `status + createdAt`; `userId + createdAt` |
| `subscribers`    | lista de drops: `email`, `token` (enlace de baja) y `notifiedDrops` (drops que ya le llegaron) | `email` único; `token` único |
| `special_orders` | solicitudes de "cazadores de reliquias" (`whatsapp`; las de antes, `email`) | `code` único |
| `users`          | cuentas (`role`: `customer` o `admin`; sin `passwordHash` = invitación pendiente; `achievements` = { id: fecha }; `seen` = slugs vistos; `extraXp`; `arcadeXp` y `arcade` = { day, game, state, free, score, xp } de la última moneda; `purchaseXp`; `nickname`; `avatarColor`) | `email` único |
| `settings`       | contenido editable de la página (`_id: "site"`); lo que falte se completa con los textos originales de `lib/site.js` | — |
| `sessions`       | sesiones (`_id` = SHA-256 del token) | TTL sobre `expiresAt`; `userId` |
| `password_resets`| códigos de recuperación (`kind: 'code'`, su huella e intentos) y enlaces de invitación (SHA-256, un solo uso) | TTL sobre `expiresAt`; `userId` |
| `rate_limits`    | ventanas de intentos por IP / correo | TTL sobre `expiresAt` |
| `media`          | imágenes de producto (binario) | `attached + createdAt` (las subidas sin guardar se limpian a las 24 h) |

Los índices se crean con `npm run seed`, no en cada petición.

## Publicar en Vercel

1. **Atlas → Network Access:** Vercel no usa IPs fijas, así que permite `0.0.0.0/0` y protege
   el acceso con un usuario de base de datos con contraseña fuerte y permisos solo sobre esta base.
   (Alternativa: la integración de MongoDB Atlas del Marketplace de Vercel, que crea la variable por ti.)
2. **Sube el proyecto a GitHub** e impórtalo en Vercel (*Add New → Project*). No necesita
   build command: `vercel.json` ya indica `public/` como salida y `api/` se detecta solo.
3. **Variables de entorno** (*Settings → Environment Variables*):
   - `MONGODB_URI` — la cadena de Atlas
   - `MONGODB_DB` — opcional, por defecto `dreamzone`
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` — todos los correos: código de recuperación, invitaciones,
     pago confirmado, pedido enviado con su guía y aviso de drops a la lista. Sin ellas no sale ninguno (los enlaces de
     invitación se pueden copiar desde el panel). Con Gmail: `smtp.gmail.com`, puerto 465 y una contraseña de aplicación.
     Pruébalo con `npm run correo:probar -- tu@correo.com`.
   - `APP_URL` — opcional, solo si los enlaces del correo deben usar un dominio distinto al de producción
   - `WOMPI_PUBLIC_KEY`, `WOMPI_PRIVATE_KEY`, `WOMPI_INTEGRITY_SECRET`, `WOMPI_EVENTS_SECRET` — pagos (panel de Wompi › Desarrolladores).
   - `CRON_SECRET` — cualquier cadena larga al azar: con ella Vercel Cron llama a la conciliación de pagos.
     Sin la pública y el de integridad, la página de pago avisa que los pagos aún no están activos.
   - `ENVIA_API_KEY` — token de producción de Envia.com para cotizar envíos en vivo (sin él, tarifas fijas: solo para pruebas).
4. **Carga los datos en la base de producción** desde tu máquina, con la URI de producción en `.env`:
   `npm run seed`.
5. Verifica `https://TU-DOMINIO.vercel.app/api/health`.

Con la CLI en lugar de Git: `npm i -g vercel`, `vercel link`, `vercel env add MONGODB_URI`, `vercel --prod`.

**En producción:** https://dreamzonesh.com, en Vercel (plan Pro), publicada con la CLI (`npx vercel deploy --prod`). Las variables de producción viven en Vercel, con las llaves marcadas como secretas. **Ojo:** si el `.env` local apunta a la misma base que producción, lo que se prueba en local queda en la tienda en línea.

### Detalles de producción

- La conexión a Mongo se reutiliza entre invocaciones (`globalThis`) y se registra con
  `attachDatabasePool` de `@vercel/functions` para cerrar conexiones ociosas correctamente.
- Direcciones limpias: `cleanUrls` en `vercel.json` sirve /cuenta, /pago, /privacidad y /admin (los archivos siguen siendo `public/*.html`) y redirige con 308 las direcciones viejas con .html, conservando ?ref=… y #sección, así que los correos ya enviados siguen funcionando. Los enlaces del código ya van sin .html; los que la curaduría guardó como «cuenta.html» en el pie salen limpios (linkAttrs en main.js). `npm run dev` hace lo mismo.
- Caché: el catálogo y los drops 10 s en la CDN (`s-maxage`), así las existencias se ven al día; los textos 60 s; carrito, cuenta y formularios nunca se cachean. El CSS y el JS se revalidan en cada visita (`max-age=0, must-revalidate` en `vercel.json`; si no cambiaron, Vercel responde 304): así un deploy nunca deja una página nueva con un JS viejo. Las imágenes de `assets/` sí se guardan 1 h.
- El carrito es anónimo: el navegador solo guarda un UUID en una cookie `HttpOnly; SameSite=Lax; Secure`.
- Las imágenes (`/api/media`) llevan `s-maxage` de un año e `immutable`: cada subida tiene un id nuevo, así que nunca hay que invalidarlas.

## Pendiente

- Facturación electrónica (Wompi no la emite) y devoluciones desde el panel (hoy se hacen en el panel de Wompi).
- El carrito todavía no se une a la cuenta: sigue siendo por navegador.
- Verificación del correo al registrarse (hoy la cuenta queda activa al instante).
- Los textos de `cuenta.html` y `404.html` aún no son editables desde el módulo Página.

- Páginas de producto y buscador (los enlaces `#` son marcadores).
