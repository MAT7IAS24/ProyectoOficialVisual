# Modificación visual del ambiente 3D · Rally v4

## Alcance

Este cambio mejora la presentación del coche y la pista que aparecen en la
reproducción web de v4. No modifica `race_env_v4.py`, las transiciones de
Gymnasium, las acciones, las recompensas, las semillas, la tabla Q ni los
resultados registrados. El entorno del modelo sigue siendo discreto; Three.js
solo visualiza las observaciones y posiciones producidas por Python.

## Cambios realizados

### Coche de rally

- Se reemplazó el bloque amarillo de v4 por una carrocería modelada con
  geometría extruida y bordes biselados.
- Se añadieron habitáculo y cristales, franjas laterales, identificación N4,
  parrilla, parachoques, faros, luces traseras, barra de luces de techo, alerón,
  llantas, cubiertas y pasos de rueda.
- Se conservan el movimiento registrado, los saltos y la cámara de seguimiento.
  Los giros de rueda siguen la distancia animada.

### Circuito

- Se aplicó a v4 una paleta más oscura de asfalto, césped menos saturado y
  materiales diferenciados para agua, barro, grava, rampas y puente.
- Se agregaron hombros exteriores de grava y pianos rojos y blancos en los
  bordes del circuito.
- La salida ahora tiene un pórtico metálico, luces de salida y rótulo N4.
- Se suavizaron las graderías, se añadieron cubiertas y se mejoró la iluminación
  para reducir el aspecto de bloques sobredimensionados.
- Se acercó ligeramente la cámara de seguimiento para dar más presencia al coche.
- Se mantuvieron los cuatro carriles, sus marcas, las rampas, el puente, los
  terrenos, obstáculos, tribunas y cámaras existentes.
- La distribución visual del público es determinista en v4: recargar la página
  ya no cambia aleatoriamente la gradería.

## Clima y movimiento durante la reproducción

- La escena recibe el clima, la acción, la velocidad y los eventos de cada frame
  registrado. Los episodios lluviosos muestran lluvia animada alrededor de la
  cámara, niebla más cercana, cielo más oscuro y asfalto con reflejo.
- Se añadió una etiqueta visible de clima seco o lluvia en el tablero para
  identificar la condición del escenario seleccionado.
- El coche inclina la carrocería al acelerar y frenar, enciende las luces de
  freno, orienta las ruedas delanteras al cambiar de carril y hace girar las
  ruedas en proporción al desplazamiento registrado. La cámara de seguimiento
  abre el encuadre a mayor velocidad.
- Los derrapes y choques producen una estela breve en las ruedas. El marcador
  del mapa 2D se interpola entre pasos para acompañar el movimiento del coche.
- Un choque sacude brevemente la cámara y resalta el puntaje en rojo; ambos
  efectos respetan la preferencia de movimiento reducido del sistema.
- El desplazamiento de N4 usa una curva de aceleración y desaceleración entre
  los puntos registrados. Las ruedas giran según la distancia recorrida; en
  lluvia reducida por accesibilidad, las gotas quedan quietas.
- Las gráficas de entrenamiento muestran la serie de episodios y la media móvil
  como trazos distintos, usan la ventana de la configuración y ajustan el eje
  vertical a los datos para que los cambios pequeños sean legibles.
- Se respeta `prefers-reduced-motion` en la animación del mapa y del indicador
  de lluvia.

## Compatibilidad

El renderer Three.js compartido aplica los temas v4 y v5 solo en sus páginas.
V3 conserva su coche, paleta, pista y controles anteriores. La pista usa los
mismos carriles y tramos que la simulación; las superficies decorativas no
participan en las reglas ni alteran la trayectoria del agente.

Archivos principales:

- `rally-dashboard/dist/scene-v3.js`: renderer compartido con mejoras
  condicionadas a v4 y v5; las funciones nuevas de N5 se activan por versión.
- `rally-dashboard/dist/track-v3.js`: paleta v4; la paleta v3 se conserva.
- `rally-dashboard/dist/app-v4.js`: activa el tema v4 y pinta el mapa de carriles
  con la misma paleta que la escena 3D; comunica el clima, la acción y los
  eventos del replay y anima el marcador del mapa.
- `rally-dashboard/dist/v4.html` y `v4.css`: tablero N4, indicador de clima,
  leyenda de curvas y compatibilidad visual para replay de lluvia.
- `rally-dashboard/dist/app-v5.js`, `v5.html` y `v5.css`: tablero N5, lectura de
  eventos de puente, recompensa de lodo y accidentes, y ritmo inicial de replay.
- `rally-dashboard/dist/index.html`, `v2.html`, `v3.html` y `v4.html`: enlaces
  de navegación hacia N5.
- `modificación_ambiente.md`: registro de las mejoras visuales del ambiente.

## Validación

- Verificar que la escena 3D inicie en `http://localhost:8000/v4.html`.
- Comprobar el coche, el césped, los pianos, los hombros y el pórtico con la
  cámara «Seguir coche», «Lateral», «Vista aérea» y «Libre».
- Reproducir condiciones normales y lluvia y comprobar que el mapa y la escena
  siguen el carril y el terreno registrados.
- Abrir `v3.html` y verificar que no adopta el modelo de coche ni la paleta N4.
- Abrir `v5.html`, confirmar los 40 tramos, tribunas densas, ritmo inicial y
  selección de clima; comparar una carrera evaluada con una reproducción de
  entrenamiento que contenga choques.
- Abrir `v4.html?seed=7&escenario=normal-2` para reproducir un cruce histórico
  del hueco del puente como salto animado.
- Si WebGL no está disponible, el navegador conserva el mapa 2D y la telemetría.
- Los efectos meteorológicos y las respuestas del coche siguen los eventos
  guardados en los frames; no introducen reglas físicas nuevas.

Las formas, luces y saltos son una visualización estilizada hecha con mallas de
Three.js; no se pretende que sean un modelo CAD ni una simulación física.

## Evolución de reglas y pista · N5

N4 queda intacto como referencia. Para que los cambios de dinámica no invaliden
su tabla Q ni sus informes, se creó la familia `rally-v5` con configuración,
ambiente, entrenamiento, pipeline, selector y tablero propios.

- La pista pasa de 3.000 a 4.000 m con diez tramos de asfalto al final. Se
  amplió el óvalo 3D para conservar el tamaño visible de cada tramo, y se
  densificaron las tribunas laterales.
- Se corrigió una duplicación de geometría: el techo de tribuna se creaba dentro
  del bucle de espectadores. N4 y N5 ahora crean un techo por grada, sin mallas
  superpuestas.
- Aumenta el combustible inicial a 190 y se extiende el estado de combustible
  exacto del agente para cubrir el nuevo rango.
- Un tramo de lodo aplica una penalización adicional de 2,5 puntos para ayudar
  a que el modelo elija una ruta más rápida cuando exista una alternativa.
- Los accidentes pasan a costar 25 puntos y retroceden dos tramos. Caer por el
  hueco del puente usa la misma regla de choque, incluida la penalización y el
  retroceso.
- A velocidad 3 se permite saltar el hueco; cada cruce exitoso queda registrado
  y el replay lo representa como vuelo sobre la plataforma. La cámara se aleja
  a mayor velocidad y la reproducción de N5 inicia a 350 ms por paso.
- La nueva recompensa de llegada es +60. El descuento `gamma` sube a 0,985 y
  el entrenamiento queda fijado en 6.000 episodios por semilla (7, 21 y 42).
- Se añadieron `race_env_v5.py`, `training_v5.py`, `pipeline_v5.py`,
  `configs/rally-v5.json`, `docs/rally-v5.md` y el tablero N5 (`v5.html`,
  `app-v5.js`, `v5.css`, `v5-results.json`). El selector general y la navegación
  web incluyen N5. Las curvas y episodios de N4 se mantienen separados.
- `environments.py`, `run_experiment.py` y `README.md` registran y describen N5;
  los enlaces de N5 también aparecen en las páginas de navegación de N1 a N4.
- El informe de previsualización es `reports/rally-v5-5fa91cd6b1ab4228897081e94da72f6e.json`.
  Está marcado como ejecución sin DVC ni MLflow.
- La animación del hueco también se habilitó para N4: sus frames ya guardados
  contienen el evento y la trayectoria del cruce, aunque no un campo específico
  de salto.

Los cambios de pista, recompensa y observación requieren entrenar N5 desde cero;
no se carga la tabla Q de N4. El código y el pipeline N5 generan nuevos IDs,
hashes e informes para conservar esa trazabilidad.

### Corrección de reproducción N5

- `app-v5.js` importaba `TERRAIN_COLORS_V5`, un símbolo que no está exportado
  por `track-v3.js`. Ese error de importación detenía el módulo completo antes
  de cargar los resultados, iniciar el replay o habilitar sus controles.
- Se cambió la importación a `TERRAIN_COLORS_V4`, paleta existente que también
  usa la escena compartida. La pista, lluvia, datos y reglas N5 no cambian.

### Ritmo de carrera y saltos visibles en N5

- El selector inicial ahora elige un episodio que contiene un salto guardado;
  varios episodios normales empezaban en otros carriles y no cruzaban rampas.
- La reproducción predeterminada bajó de 350 ms a 120 ms por acción, con ajuste
  entre 60 y 900 ms. N5 interpola linealmente cada transición y usa todo el
  intervalo para que el auto no desacelere artificialmente al final de cada paso.
- N4 conserva su temporización y curva de movimiento originales. La física del
  entorno, las acciones aprendidas y los resultados guardados no cambian.

### Choque obligatorio con barriles N5

Se corrigió la prioridad de la transición al llegar a `rampa_con_barril`: ahora
el barril se resuelve antes de evaluar la velocidad de salto. El choque detiene
el avance, devuelve el auto dos tramos, aumenta accidentes y aplica la penalidad
configurada de accidente. La política de referencia ahora intenta cambiar de
carril para evitar también ese obstáculo. Los resultados históricos no se
recalculan automáticamente; la nueva regla toma efecto en futuras corridas.
