# Autonomous Rally: primer entorno

Prototipo de una carrera automática con Gymnasium y Q-learning tabular.

- Pista cerrada de **1.000 m**: completar la vuelta devuelve el coche a la
  línea de salida/meta.
- El coche puede ir en reversa (−100 m, sin pasar la salida) o acelerar
  (100 m) por paso.
- Recompensa: **+10** al llegar a la meta; **-1** en cada paso que no termina.
- Cada episodio se **trunca en 50 pasos** si aún no terminó.
- El CLI se actualiza en tiempo real con una pista ASCII, el coche avanzando y
  el puntaje del episodio dentro de la pista; también muestra exploración y los
  valores `Q(reversa)`, `Q(acelerar)` y `V(s)` del estado de decisión.

## Ejecutar

```bash
source .venv/bin/activate
python train.py --episodes 25
```

Para una ejecución rápida sin pausa:

```bash
python train.py --episodes 5 --delay 0
```

El entorno está en `race_env.py`; aún no simula curvas, sensores ni física
continua. Es una base discreta y verificable para añadirlas después.

## Tablero visual web

El directorio `rally-dashboard/dist` contiene un tablero de navegador con una
pista ilustrada, coche animado, puntaje dentro de la pista, telemetría y valores
Q que se actualizan en cada paso. El simulador visual replica las reglas de este
primer entorno y se controla con pausar/reanudar, reiniciar y velocidad.

Para verlo localmente:

```bash
cd rally-dashboard/dist
python3 -m http.server 8000
```

Abre `http://localhost:8000` en el navegador.

### Vista 3D con Three.js

El tablero incorpora una escena 3D: coche amarillo, asfalto, bordillos, arco de
salida/meta, iluminación, sombras y cámara interactiva. Arrastra sobre la pista
para girar la cámara y utiliza la rueda para acercar o alejar. Los botones
**Perspectiva** y **Vista aérea** restauran las vistas del circuito.

La escena usa la misma curva del visual anterior. Interpola la distancia sobre
esa curva entre pasos, tanto al avanzar como al retroceder; al reiniciar un
episodio devuelve el coche a la salida. Esta interpolación es solo visual:
conserva las acciones de ±100 m, recompensas, Q-learning y corte a 50 pasos.
El entorno Python y el CLI no se modifican. El tablero sigue ejecutando su
simulación JavaScript, como antes; no está conectado al proceso Python.

Three.js **0.180.0**, OrbitControls y su licencia MIT están incluidos en
`rally-dashboard/dist/vendor/three`, siguiendo la [instalación con módulos de
Three.js](https://threejs.org/manual/pages/installation.html). No necesitas
Node.js ni conexión a un CDN para abrir el tablero con el servidor Python.
La vista 3D requiere WebGL 2. Si no está disponible, se conserva el visual 2D.

## Versionado y experimentos

El primer entrenamiento interactivo no guardó su tabla Q ni las transiciones.
El siguiente flujo genera **una nueva corrida reproducible** usando las mismas
reglas e hiperparámetros del CLI, no recupera los resultados anteriores.

```bash
source .venv/bin/activate
uv pip install -r requirements.txt
PREFECT_SERVER_EPHEMERAL_ENABLED=true python pipeline.py --episodes 25 --seed 7
```

Prefect ejecuta tres tareas: entrena el agente y genera las transiciones,
versiona el CSV con DVC y registra parámetros, métricas por episodio,
evaluación greedy y artefactos en MLflow. Los archivos `.dvc` y los `.gitignore`
creados por DVC deben incluirse en cada commit. El CSV vive en la caché local de
DVC; **aún no hay almacenamiento remoto configurado**, por lo que otra
persona no puede recuperar esos datos con `dvc pull` hasta configurar uno.
Con un almacenamiento compartido accesible por todo el equipo, configura y
sube el dataset (consulta [remotos de DVC](https://dvc.org/doc/start/data-management/data-versioning)):

```bash
dvc remote add -d almacenamiento <URL-O-RUTA-COMPARTIDA>
dvc push
git add .dvc/config data/experiments
```

Las rutas no contienen credenciales: configura claves privadas mediante
`dvc remote modify --local` o las variables de entorno del proveedor. Otra
persona podrá recuperar los archivos con `dvc pull` después de obtener el
commit y el acceso al almacenamiento.

MLflow guarda la base y los artefactos localmente (se ignoran en Git). Para
consultarlos, desde la raíz del proyecto:

```bash
mlflow ui --backend-store-uri sqlite:///mlflow.db --port 5000
```

Abre `http://localhost:5000`. También puedes definir `MLFLOW_TRACKING_URI` para
usar un servidor compartido; configura su almacenamiento de artefactos antes de
ejecutar el flujo. Los archivos `models/<id>/q_table.npy`, `metadata.json` y
`README.md` forman el paquete de modelo de cada corrida; MLflow guarda una
copia como artefacto. En `metadata.json` quedan las huellas SHA-256 del dataset,
modelo y código fuente, las acciones, parámetros y evaluación.

Para publicar una corrida en un repositorio **privado** de Hugging Face:

```bash
hf auth login
python publish_model.py models/<ID-DE-CORRIDA> --repo-id <USUARIO-HF>/<REPOSITORIO>
```

El token necesita permiso de escritura. El script crea el repositorio privado si
no existe, rechaza repositorios públicos y publica bajo `runs/<id>`; no almacenes
el token en Git. Cada ejecución del pipeline imprime el ID y las rutas que hay
que usar. El modelo es una tabla Q de NumPy, no una red neuronal.
