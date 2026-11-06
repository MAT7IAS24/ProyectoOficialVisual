# Experimento 2 · rally-v2 / reward v2

## Estructura y selección

La exploración del repositorio encontró: `race_env.py` (ambiente v1), `train.py`
(CLI v1), `pipeline.py` (Prefect, DVC, MLflow y evaluación v1),
`publish_model.py` (Hugging Face) y `rally-dashboard/dist/` (web independiente).
Los tres archivos Python de v1 y `app.js` permanecen idénticos a la versión
anterior. El modelo de v1 y sus datos también se conservan.

V2 vive en `race_env_v2.py`, `training_v2.py`, `pipeline_v2.py` y
`configs/rally-v2.json`. La configuración contiene reglas, zonas, recompensas,
hiperparámetros y semillas. No hay duplicación de reglas v2 en JavaScript.

```bash
source .venv/bin/activate
# V1 sigue disponible con sus comandos originales:
python train.py --episodes 25
# O mediante el selector común:
python run_experiment.py --environment-version rally-v1 --episodes 25
# V2: entrena 3 semillas independientes de 3000 episodios cada una:
PREFECT_SERVER_EPHEMERAL_ENABLED=true python run_experiment.py --environment-version rally-v2
# Configuración alternativa o prueba corta (no sobrescribe modelos anteriores):
python pipeline_v2.py --config configs/rally-v2.json --episodes 100 --seeds 7
```

`environments.make_env('rally-v1')` o `make_env('rally-v2')` selecciona la clase.
V2 empieza con una tabla Q nueva para cada semilla. Las tres semillas por defecto
son 7, 21 y 42: 7 es la corrida base, no se ejecuta dos veces.

## Contrato Gymnasium

Observación: `Tuple(Discrete(11), Discrete(4), Discrete(4), Discrete(3))`:
`(tramo, speed_level, fuel_bucket, zone_type)`. El bucket es 0 para combustible
<=25, 1 para <=50, 2 para <=75 y 3 para >75. Zonas: 0 recta, 1 seca, 2 mojada.
`action_space = Discrete(3)`; 0 frena, 1 mantiene y 2 acelera.

Q tiene forma **(528, 3)**. La fila se calcula con
`numpy.ravel_multi_index(obs, (11, 4, 4, 3))`, orden C. Hay combinaciones
inalcanzables (el tipo de zona depende del tramo); se conservan para respetar
el producto cartesiano del espacio solicitado.

`reset(seed=...)` devuelve `(obs, info)`. `step(action)` devuelve
`(obs, reward, terminated, truncated, info)` y rechaza acciones fuera del espacio
o pasos tras finalizar el episodio. `info` contiene todos los campos solicitados,
versiones, grip, combustible consumido, tramos premiados en ese paso y el desglose
de recompensa. Durante el episodio `termination_cause='en_curso'`.

El estado interno también mantiene `off_track_count`, `steps` y
`rewarded_segments`. **La observación solicitada no es completamente Markoviana**:
oculta los premios históricos, el contador de salidas y el combustible exacto.
La tabla Q usa exactamente la observación pedida; este límite se conserva y
no se añaden variables ocultas a la entrada del agente.

## Orden de transición y casos frontera

1. Incrementar pasos y aplicar la acción a la velocidad (saturada entre 0 y 3).
2. Consumir `2 + 3*speed_level`, usando la velocidad anterior al accidente.
   El consumo efectivo se limita al combustible disponible; nunca queda negativo.
3. Recorrer en orden **cada tramo atravesado**, incluidos los intermedios si se
   avanza 200 o 300 m. Al entrar en la primera curva insegura se detiene el
   movimiento, se vuelve un tramo respecto a esa curva y la velocidad queda a 0.
4. Solo las entradas válidas reciben +2, una vez por tramo y episodio. El tramo
   0 empieza marcado; el tramo 10 también recibe premio al entrar en meta.
   El tramo inseguro que provoca el accidente no recibe premio. Un retroceso
   no elimina los premios ya cobrados y no permite repetirlos.
5. Resolver el final: meta (`vuelta_completada`), tercera salida
   (`salidas_de_pista`), combustible cero (`sin_combustible`), en ese orden.
   Si ninguna terminación aplica y se llega a 50 pasos, truncar con
   `limite_pasos`. Llegar a meta con exactamente cero combustible es éxito.

En las zonas 3 y 4 la velocidad segura es 2 (grip 0.8); en 7 y 8 es 1
(grip 0.5). Grip identifica la zona: no añade azar ni multiplica el avance.
La comprobación se hace al **entrar** al tramo; permanecer quieto no cuenta como
una entrada nueva. El retroceso es consecuencia de un accidente, no una acción.

Recompensa total: −1 por paso, +2 por tramo nuevo válido, −0.05 por unidad
efectivamente consumida, −8 por accidente y, al completar, +20 + 0.1*fuel.
Todos los coeficientes se leen del JSON. Ejemplo: diez pasos a nivel 1 dejan
50 de combustible y un retorno de 32.5.

Con la configuración original, quedarse detenido consume 100 unidades en
50 pasos: en ese caso termina por combustible, en vez de truncarse. El límite
sigue existiendo; se prueba con combustible suficiente o menor consumo.

## Entrenamiento, evaluación y registros

Q-learning: alpha 0.25, gamma 0.95, epsilon lineal de 1 a 0.05 a lo largo de
3000 episodios, RNG independiente por semilla y desempates aleatorios durante
entrenamiento. La evaluación congela Q, usa argmax sin exploración y 30 episodios
con semillas separadas. Una terminación no usa bootstrap; un truncamiento por
límite externo sí, conforme a [Gymnasium](https://gymnasium.farama.org/v0.26.3/tutorials/handling_time_limits/).

Prefect ejecuta entrenamiento → DVC → MLflow para cada semilla. MLflow usa el
experimento `autonomous-rally-v2`, separado de `autonomous-rally`. Guarda métricas
por episodio, Q min/max, error TD, evaluación y copias del código/configuración.
Cada corrida produce un UUID nuevo y conserva los anteriores:

- `data/experiments/rally-v2-<uuid>/transitions.csv` y referencia `.dvc`.
- `models/rally-v2-<uuid>/`: tabla Q, configuración exacta, metadata, métricas,
  evaluación y model card compatible con `publish_model.py`.
- `reports/rally-v2-<uuid>.json`: relación entre semillas, modelos, datasets,
  IDs MLflow, hashes y media/varianza/desviación muestral entre semillas.

El ambiente es determinista; la variación proviene del entrenamiento. Que todas
las semillas lleguen a la misma política puede producir **varianza final cero**.
No se modifica la recompensa ni se inventa ruido para forzar diferencias.
Con una única semilla, varianza/desviación muestral son `null`, no cero.
Los registros conservan la revisión Git base y las huellas del código ejecutado;
las copias de código en MLflow permiten recuperar también cambios aún sin commit.

DVC y MLflow siguen usando almacenamiento local. No se cambia el remoto ni se
publican automáticamente modelos nuevos en Hugging Face. La publicación sigue
siendo explícita mediante `publish_model.py`, en una carpeta nueva por corrida.

## Interfaz web

```bash
python3 -m http.server 8000 --directory rally-dashboard/dist
```

`http://localhost:8000/` conserva v1. El enlace **Experimento 2 · N2** abre
`v2.html`: selecciona semilla y una evaluación o muestras de los primeros/últimos
episodios. Muestra combustible, velocidad, zona, grip, salidas, causa, puntos y
los tres valores Q. La escena colorea las zonas secas y mojadas.

Esta vista es una **reproducción registrada**, no entrenamiento en vivo: consume
`v2-results.json`, generado por el pipeline Python. El historial completo está
en el CSV/MLflow; el JSON web contiene muestras acotadas y los resultados de
evaluación. Cada nueva ejecución actualiza solo la vista web más reciente y
genera un informe y artefactos con UUID distinto.

## Verificación

```bash
python -m unittest discover -s tests -v
```

Las pruebas cubren contrato Gymnasium, zonas intermedias, recompensas únicas,
umbrales inclusivos de combustible, salida triple, combustible, meta, límite,
configuración, reproducibilidad, bootstrap y regresión v1. La regresión conserva
las huellas de sus fuentes y compara la tabla Q de 25 episodios/semilla 7 con
la huella del modelo original.
