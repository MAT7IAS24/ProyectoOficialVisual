# Experimento 4 · rally-v4 / N4

## Objetivo y límites

V4 conserva el circuito de 3.000 m, los cuatro carriles, terrenos, acciones y
Q-learning tabular de N3 para aislar el cambio principal: el agente recibe ahora
las variables históricas que afectan transiciones, terminación o recompensa.
V1, V2 y V3 permanecen disponibles y sus ambientes no se ejecutan durante el
entrenamiento de V4. `race_env_v4.py` y `configs/rally-v4.json` son la definición
ejecutable independiente de N4. El pipeline reutiliza únicamente la utilidad
de `dvc add` de `pipeline.py`; no invoca el entrenador ni el ambiente de V1.

La hipótesis y los criterios previos están en `experiment` dentro de la
configuración: éxito mínimo del 90 % tanto en pista normal como bajo lluvia.
Cada semilla entrena con una mezcla fijada de 50 % clima normal y 50 % lluvia.
Los resultados se comparan además con políticas aleatoria y de reglas, en la
misma suite fija de evaluación. Un umbral no alcanzado se informa como tal; no se
ajustan criterios después de ver las métricas.

## Observación, acciones y memoria del modelo

La observación Gymnasium contiene once enteros, en este orden:

1. Tramo (0–30).
2. Nivel de velocidad (0–3).
3. Bucket de combustible (0–3), conservado para facilitar inspección/comparación.
4. Carril (0–3).
5. Capa: suelo (0) o puente (1).
6. Tipo de terreno siguiente (0–9) o meta (10).
7. Combustible exacto restante (0–150).
8. Accidentes acumulados (0–4).
9. Pasos consumidos (0–100).
10. Mejor tramo alcanzado (0–30), necesario porque el premio por avance no se
    vuelve a cobrar al retroceder.
11. Clima: normal (0) o lluvia (1).

Así se exponen los contadores ocultos de N3 y se distingue el clima que determina
el mapa. El estado contiene **206.359.450.880 combinaciones teóricas** (más de un
billón de pares estado-acción); crear una tabla densa sería inviable. Q-learning
conserva únicamente los estados visitados en un diccionario disperso y los guarda
en `q_table.npz` como pares `state_ids`/`values`. Los estados no vistos tienen
valores Q iniciales en cero.
El modelo ofrece cinco acciones: frenar, mantener, acelerar y cambiar al carril
izquierdo o derecho.

La observación conserva los primeros seis campos de v3 y amplía el resto; no se
reutiliza una tabla Q v3 como si fuera compatible. Se mantiene la misma pista y
la misma recompensa de N3 para que el resultado no mezcle cambios de objetivo.
V4 usa una copia versionada de las reglas del ambiente; su entrenador no ejecuta
los ambientes ni las políticas de los experimentos anteriores.

## Gráficas y reproducción

`rally-dashboard/dist/v4.html` presenta la pista 3D y la telemetría, además de
curvas por semilla para retorno medio móvil, éxito, accidentes y error TD
absoluto. Las medias móviles son de 100 episodios. La tabla compara Q-learning,
la política de reglas y la aleatoria en ambas condiciones climáticas.

El tablero reproduce cuadros registrados por Python; no simula un segundo agente
ni representa entrenamiento en vivo. El pipeline genera
`rally-dashboard/dist/v4-results.json` junto con las series de métricas usadas
por las gráficas.

## Instalación, entrenamiento y pruebas

Desde PowerShell, en la raíz del repositorio:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
py -m pip install -r requirements.txt
```

Prueba corta (omite DVC y MLflow; solo sirve para verificar o regenerar la vista):

```powershell
py pipeline_v4.py --skip-tracking --episodes 100 --seeds 7
```

Corrida completa, tres semillas, DVC y MLflow locales:

```powershell
$env:PREFECT_SERVER_EPHEMERAL_ENABLED = "true"
py run_experiment.py --environment-version rally-v4
```

Pruebas del contrato Gymnasium, variables del estado y persistencia dispersa:

```powershell
py -m unittest tests.test_rally_v4 -v
```

Servidor del tablero:

```powershell
py -m http.server 8000 --directory rally-dashboard/dist
```

Abre `http://localhost:8000/v4.html`. El entrenamiento por defecto usa 4.000
episodios por semilla (7, 21 y 42), `alpha=0.25`, `gamma=0.97` y epsilon lineal
de 1.0 a 0.05. La evaluación utiliza 40 episodios por condición y semilla.

## Artefactos y trazabilidad

Cada semilla produce un identificador nuevo:

- `models/rally-v4-<uuid>/q_table.npz`: tabla Q dispersa.
- `config.json`, `metadata.json`, `manifest.json`, `training_metrics.json`,
  `evaluation.json` y un README del modelo.
- `data/experiments/rally-v4-<uuid>/transitions.csv`: transiciones con estado,
  acción, recompensa, estado siguiente, terminación, clima y métricas Q.
- `reports/rally-v4-<uuid>.json`: evaluación por clima, baselines, variación
  entre semillas y resultado de los criterios.
- `rally-dashboard/dist/v4-results.json`: resumen, replays y series del tablero.

La corrida normal registra datos con DVC y parámetros/métricas/artefactos en
MLflow. Sin configurar `MLFLOW_TRACKING_URI`, ambas herramientas se guardan
localmente (`.dvc/cache`, `mlflow.db`, `mlruns/`). El repositorio no contiene
un remoto DVC ni un servicio MLflow compartido: `dvc push` y el acceso de otras
personas requieren que el equipo proporcione y configure un almacenamiento
compartido y sus permisos. Nunca se guardan credenciales en Git.

La corrida `--skip-tracking` se almacena bajo `.prueba-sin-tracking/`, omite
DVC/MLflow y queda identificada como prueba. No debe presentarse como artefacto
oficial reproducible.

## Corrida oficial incluida

Suite `rally-v4-d3818c9157a64757aa94a27c9f427370`, tres semillas, 4.000
episodios por semilla, DVC y MLflow local. El criterio previo se cumplió: las
tres semillas dieron 100 % de éxito en ambas condiciones, con estos promedios:

| Política | Condición | Éxito | Retorno medio | Pasos | Accidentes |
|---|---|---:|---:|---:|---:|
| Q-learning v4 | Normal | 100 % | 59,84 | 15,36 | 0,26 |
| Q-learning v4 | Lluvia | 100 % | 61,23 | 15,28 | 0,11 |
| Reglas | Normal | 53 % | 0,81 | 39,15 | 0,47 |
| Reglas | Lluvia | 53 % | 0,81 | 39,15 | 0,47 |
| Aleatoria | Normal | 8 % | −17,65 | 35,13 | 1,77 |
| Aleatoria | Lluvia | 5 % | −19,35 | 35,20 | 1,83 |

El informe completo y las métricas por semilla están en
[`reports/rally-v4-d3818c9157a64757aa94a27c9f427370.json`](../reports/rally-v4-d3818c9157a64757aa94a27c9f427370.json).
Estos resultados son de esta configuración y suite; no implican que la tabla Q
generalice a mapas o perturbaciones no evaluados.

## Riesgos y comparación

La tabla Q sigue siendo tabular: estados nuevos no comparten experiencia y la
política puede elegir frenar ante estados no visitados. El almacenamiento
disperso evita reservar memoria para combinaciones teóricas, pero no elimina el
coste de explorar suficientes estados. La observación incluye el clima actual,
no una predicción meteorológica futura.

Para una comparación, usar el mismo número de semillas, suite de evaluación y
mapas normal/lluvia. Las tablas Q de V3 no se pueden cargar en V4: cambió el
espacio de estados. Las cifras publicadas de V3 son contexto histórico, no una
comparación pareada sobre el modelo V4.
