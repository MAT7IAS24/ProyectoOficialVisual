# Autonomous Rally · Proyecto final de MLOps

Visualización 2 · Universidad Externado de Colombia. Un coche aprende a correr una pista con
aprendizaje por refuerzo. Cada experimento es una **versión con nombre** (etiqueta de Git) con su
código, sus datos versionados (DVC), sus corridas (MLflow) y su vista web.

| Versión | Qué agrega | Resultado | Código | Documentación |
|---|---|---|---|---|
| **N1** · `rally-v1-n1` | Pista de 1 km, 2 acciones, pipeline Prefect + DVC + MLflow | 100 % vueltas, 10 pasos | [ver](https://github.com/MAT7IAS24/ProyectoOficialVisual/tree/rally-v1-n1) | [README](https://github.com/MAT7IAS24/ProyectoOficialVisual/blob/rally-v1-n1/README.md) |
| **N2** · `rally-v2-n2` | Velocidad, combustible, curvas seca y mojada, 3 semillas, Hugging Face | 100 %, retorno +36,4 | [ver](https://github.com/MAT7IAS24/ProyectoOficialVisual/tree/rally-v2-n2) | [rally-v2.md](docs/rally-v2.md) |
| **N3** · `rally-v3-n3` | 4 carriles, rampas, puente, referencias, incidente de lluvia con intervenciones A/B | 100 % vs 53 % reglas; B recupera la lluvia | [ver](https://github.com/MAT7IAS24/ProyectoOficialVisual/tree/rally-v3-n3) | [rally-v3.md](docs/rally-v3.md) |
| **N4** · `rally-v4-n4` | Física continua (m/s, agarre, gravedad), pista nueva en cada carrera, PPO (red neuronal) vs Q-learning | PPO 20 % vs Q-learning 6 % en pistas nuevas; hipótesis (≥70 %) no confirmada | [ver](https://github.com/MAT7IAS24/ProyectoOficialVisual/tree/rally-v4-n4) | [rally-v4.md](docs/rally-v4.md) |
| **N5** · `rally-v5-n5` | Llantas de Pacejka, círculo de agarre, volante y pedal graduales, barro con surcos, asfalto en la web; 2 intentos | Barro 12° → 2,7° y reglas 87 % (cumplen); PPO 0 % (intento 1) → 10 % (intento 2), meta 15 %: rechazado | [ver](https://github.com/MAT7IAS24/ProyectoOficialVisual/tree/rally-v5-n5) | [rally-v5.md](docs/rally-v5.md) |
| **N6** · `rally-v6-n6` | Transferencia de peso, suspensión (cabeceo, balanceo, aterrizajes), frenos según el peso, 6 sensores nuevos, reglas reajustadas | Banco: cabeceo 2,1° y balanceo 3,5° (cumplen); reglas 87 %; PPO 10 % → 12 % (meta 15 %): rechazado | [ver](https://github.com/MAT7IAS24/ProyectoOficialVisual/tree/rally-v6-n6) | [rally-v6.md](docs/rally-v6.md) |
| **N7** · `rally-v7-n7-maestro` | Aprender de un maestro: PPO primero imita a las reglas (DAgger) y después afina solo. Misma física del N6, mirada de piloto (250 sensores). 3 intentos; los dos primeros (PPO desde cero, etiqueta `rally-v7-n7`) quedaron rechazados y guardados. Web: ruedas arregladas, polvo, chispas, confeti, luces de freno y línea de cada coche | Intento 3: PPO 80 % (N6: 12 %), 1,28 accidentes por vuelta (N6: 2,29), lluvia 58 %; meta 70 %: aceptado. Solo imitando: 83 %; reglas: 87 % | [ver](https://github.com/MAT7IAS24/ProyectoOficialVisual/tree/rally-v7-n7-maestro) | [rally-v7.md](docs/rally-v7.md) |

**Web pública:** https://autonomous-rally-lake.vercel.app (Vercel, equipo visual-2).
`rally-dashboard/dist/historial.html` es la portada con el historial y enlaces a la carrera
de cada versión (`index.html`, `v2.html`, `v3.html`, `v4.html`, `v5.html`, `v6.html`, `v7.html`). Para volver exactamente a una versión:
`git checkout rally-v3-n3` (o la etiqueta que corresponda).

---

## Detalle del experimento 1

**Experimento 3 (N3) disponible:** [guía de rally-v3](docs/rally-v3.md): pista de 3.000 m,
4 carriles con obstáculos propios, rampas, puente elevado, cámara que sigue al coche e
incidente de lluvia con dos intervenciones. Web: `rally-dashboard/dist/v3.html`.

**Experimento 2 (N2) disponible:** [guía de rally-v2](docs/rally-v2.md).
El experimento 1 conserva su ambiente, entrenamiento y registro originales.
La web ofrece enlaces para seleccionar los tres experimentos.

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
