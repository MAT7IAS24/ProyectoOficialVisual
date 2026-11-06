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

## Compatibilidad

El renderer Three.js compartido aplica el nuevo tema solo si se abre la página
v4. V3 conserva su coche, paleta, pista y controles anteriores. La pista usa los
mismos carriles y tramos que la simulación; las superficies decorativas no
participan en las reglas ni alteran la trayectoria del agente.

Archivos principales:

- `rally-dashboard/dist/scene-v3.js`: renderer compartido con mejoras
  condicionadas exclusivamente a v4.
- `rally-dashboard/dist/track-v3.js`: nueva paleta v4; la paleta v3 se conserva.
- `rally-dashboard/dist/app-v4.js`: activa el tema v4 y pinta el mapa de carriles
  con la misma paleta que la escena 3D.
- `rally-dashboard/dist/v4.html`: página del experimento 4.

## Validación

- Verificar que la escena 3D inicie en `http://localhost:8000/v4.html`.
- Comprobar el coche, el césped, los pianos, los hombros y el pórtico con la
  cámara «Seguir coche», «Lateral», «Vista aérea» y «Libre».
- Reproducir condiciones normales y lluvia y comprobar que el mapa y la escena
  siguen el carril y el terreno registrados.
- Abrir `v3.html` y verificar que no adopta el modelo de coche ni la paleta N4.
- Si WebGL no está disponible, el navegador conserva el mapa 2D y la telemetría.

Las formas, luces y saltos son una visualización estilizada hecha con mallas de
Three.js; no se pretende que sean un modelo CAD ni una simulación física.
