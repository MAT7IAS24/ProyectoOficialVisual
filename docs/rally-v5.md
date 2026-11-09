# Experimento 5 · rally-v5 / N5

N5 conserva N4 como referencia histórica y crea una nueva versión reproducible
para los cambios de pista, recompensa y accidentes solicitados.

## Cambios de reglas

- La vuelta mide 4.000 m (40 tramos de 100 m). Los 10 tramos nuevos forman una
  recta de salida limpia después de los obstáculos, para dar espacio a cambiar
  de carril, acelerar y recuperar velocidad antes de meta.
- La reserva inicial de combustible sube a 190 unidades. El entrenamiento usa
  un descuento `gamma=0.985` para valorar rutas que requieren preparación.
- Entrar en una casilla de lodo añade una penalización de -2,5.
- Un accidente cuesta 25 puntos, detiene el coche y lo devuelve dos tramos. El
  máximo de accidentes por episodio sigue siendo cuatro.
- El hueco del puente se cruza solo a velocidad 3. Ir más lento o aterrizar en
  el hueco produce un accidente normal, con penalización y retroceso. Un cruce
  exitoso queda registrado como salto para que el replay muestre la trayectoria
  sobre el hueco.
- Llegar a meta vale +60. Las recompensas restantes conservan el coste por
  paso, combustible y avance de N4.

## Modelo y ejecución

El estado mantiene las 11 variables de N4, pero se vuelve a entrenar desde cero:
la longitud, combustible, recompensas y transiciones cambiaron. La configuración
usa 6.000 episodios por semilla (7, 21 y 42), mezcla 50/50 de clima normal y
lluvia, y 50 episodios de evaluación por clima y semilla.

```powershell
$env:PREFECT_SERVER_EPHEMERAL_ENABLED = "true"
py run_experiment.py --environment-version rally-v5
```

Para generar una vista local sin DVC ni MLflow:

```powershell
py pipeline_v5.py --skip-tracking --episodes 1000 --seeds 7
```

El modo `--skip-tracking` se marca como corrida de prueba. No se debe confundir
con la corrida completa de tres semillas registrada por DVC y MLflow.

La previsualización actual usa 6.000 episodios y las tres semillas. Alcanzó
100 % de éxito en las 50 evaluaciones normales y las 50 evaluaciones lluviosas
de cada semilla, con cero accidentes en evaluación. Está marcada como prueba:
este entorno no tenía Gymnasium, Prefect, DVC ni MLflow instalados, por lo que
la ejecución local sustituyó las interfaces de entorno y flujo para generar el
modelo de vista previa, sin tracking oficial. Repite la corrida completa con
las dependencias del proyecto antes de publicar esos resultados como oficiales.
El informe de esa vista es `reports/rally-v5-5fa91cd6b1ab4228897081e94da72f6e.json`;
los artefactos locales de la corrida de prueba quedan bajo
`.prueba-sin-tracking/`.

El tablero está en `rally-dashboard/dist/v5.html`. Si el servidor local está
activo, abre `http://localhost:8000/v5.html`. Para iniciarlo desde la raíz:

```powershell
py -m http.server 8000 --directory rally-dashboard/dist
```

El replay inicia a 350 ms por paso y permite pausar, ajustar la velocidad y
seleccionar lluvia. Para ver un cruce del hueco que ya está guardado en los
frames históricos de N4, abre `http://localhost:8000/v4.html?seed=7&escenario=normal-2`.

## Artefactos

Cada corrida completa genera una tabla Q dispersa, transiciones, métricas,
evaluación por clima y un informe con identificadores y hashes, con prefijo
`rally-v5-`. Los resultados del tablero se escriben en
`rally-dashboard/dist/v5-results.json`. N4 y sus artefactos originales se
conservan sin cambios.

### Corrección de carga del tablero

La reproducción N5 no iniciaba porque `app-v5.js` pedía un export inexistente
(`TERRAIN_COLORS_V5`) a `track-v3.js`. El error de módulo impedía ejecutar la
carga de datos y los controles. La importación ahora usa `TERRAIN_COLORS_V4`,
igual que la escena compartida; no se modificaron resultados ni reglas.

### Ritmo de reproducción

El tablero abre un escenario con un salto registrado, porque algunos episodios
normales no recorren las rampas. N5 reproduce a 120 ms por acción inicialmente,
permite ajustar de 60 a 900 ms y mantiene interpolación lineal continua entre
frames. Esto solo cambia presentación; el modelo y los datos registrados se
conservan.

### Barriles como obstáculo obligatorio

La regla N5 ahora procesa el barril de una rampa antes de evaluar el salto. Si
el auto alcanza esa casilla, choca, pierde puntos, se detiene y retrocede dos
tramos incluso a velocidad de salto. La política de referencia trata el barril
de rampa como obstáculo evitable y cambia de carril cuando puede. Los resultados
históricos del tablero siguen siendo snapshots de la corrida anterior; para
representar esta regla en datos nuevos se debe volver a ejecutar el pipeline.
