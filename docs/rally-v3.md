# Experimento 3 · rally-v3 / reward v3 (nivel N3)

> **En una frase:** el coche ahora corre una pista de **3.000 m** con **4 carriles**, y cada
> carril tiene su propio problema (lodo, agua, pedazos sin pista, fosos, barriles). Hay
> **rampas** para saltar y un **puente elevado** (plataforma suspendida). El agente tiene que
> aprender **por cuál carril ir, cuándo cambiarse y con qué velocidad llegar a cada rampa**.

Los experimentos 1 y 2 no se tocaron: sus archivos, modelos y páginas siguen iguales
(hay una prueba automática que lo verifica con huellas SHA-256).

---

## 1. La pista

Son 30 tramos de 100 m. Cada carril es una fila de 30 casillas. Así se ve en la
configuración (`configs/rally-v3.json`), donde cada letra es un tipo de terreno:

```
              0         10        20        29   ← tramo
Carril 1      ....LLL.....LL......LLL.......       Lodo
Carril 2      ......AA.....AA......AAA....A.       Agua
Carril 3      ...SSS..RFFA.....SSS...RFFA...       Pista incompleta
Carril 4      ...B..K...R.LLAA.FLL..K...B.R.       Rampas y puente
  (puente)    ------------PPPPPGPP----------       ← segundo piso del carril 4
```

| Letra | Terreno | Qué le pasa al coche |
|---|---|---|
| `.` | Tierra lisa | Nada, se puede ir a cualquier velocidad |
| `L` | Lodo | Lo frena: su velocidad baja a 1 y ese paso se detiene ahí |
| `A` | Agua | Si entra con velocidad 3, **derrapa** (accidente). Con 2 o menos pasa |
| `S` | Sin pista (pasto) | Lo frena a velocidad 2 |
| `F` | Foso | Siempre es accidente |
| `B` | Barril | Siempre es accidente (hay que cambiarse de carril) |
| `R` | Rampa | Con velocidad 2 o 3 **salta**; más lento la sube despacio y no salta |
| `K` | Rampa con barril | Igual que la rampa, pero si llega lento **choca** con el barril |
| `P` | Puente | Plataforma elevada: solo se llega saltando |
| `G` | Hueco del puente | Solo se cruza con velocidad 3; más lento, cae al suelo |

Un **accidente** cuesta −8 puntos, devuelve el coche un tramo atrás y lo deja en velocidad 0.
Con 4 accidentes el episodio termina.

**¿Por qué cada carril tiene algo distinto?** Para que el agente tenga que *elegir*. No hay
un carril perfecto: el 1 es lento por el lodo, el 2 obliga a no ir a fondo, el 3 tiene una
rampa trampa (aterriza en un foso o en agua) y el 4 tiene barriles pero también el atajo
del puente. La mejor ruta combina carriles.

## 2. Qué puede hacer y qué "ve" el coche

**5 acciones:** frenar, mantener, acelerar, cambiarse al carril de la izquierda, cambiarse al
de la derecha. Cambiar de carril cuesta 1 unidad extra de combustible, no se puede hacer
sobre el puente, y si va a velocidad 3 derrapa (accidente).

**Lo que observa** (6 datos, todos números enteros):

1. en qué tramo va (0 a 30)
2. su velocidad (0 a 3)
3. cuánto combustible le queda, en 4 niveles
4. en qué carril va (1 a 4)
5. si está en el suelo o en el puente
6. **qué terreno tiene justo adelante** (esto es lo que le permite reaccionar)

Combinando todo hay 43.648 situaciones posibles × 5 acciones. El agente guarda una tabla
(tabla Q) con "qué tan buena es cada acción en cada situación" y la va llenando con la
experiencia. No ve cuántos accidentes lleva: igual que en v2, la observación es
**parcial**, a propósito.

**Salida aleatoria:** en cada episodio el coche arranca en un carril al azar (controlado por
la semilla). Así no puede memorizar un único camino: tiene que saber salir de cualquier carril.

## 3. Cómo se modelan las rampas

Hay que separar dos cosas: **la regla** (Python, decide qué pasa) y **el dibujo** (Three.js,
solo lo muestra). El dibujo nunca decide nada.

**La regla (en `race_env_v3.py`)**, pensada como un trampolín:

- Si el coche entra a una rampa con velocidad **2**, vuela **2 tramos**; con velocidad
  **3**, vuela **3 tramos** (`flight_segments` en la configuración).
- Mientras vuela **no toca lo que hay debajo**: puede pasar por encima de un foso o de lodo.
- Lo que sí cuenta es **dónde aterriza**: si cae en agua yendo a 3, derrapa; si cae en un
  foso, se accidenta; si cae sobre el puente, queda arriba.
- Si llega a menos de 2, la sube despacio y no salta (y si es una rampa con barril, choca).

Por eso el agente no puede "acelerar siempre": tiene que llegar a cada rampa con la
velocidad exacta para caer en un buen lugar.

**El dibujo (en `scene-v3.js`):** la rampa es una cuña que sigue la curva de la pista. Se
construye con una función (`strip`) que arma un bloque a lo largo del carril y le da una
altura a cada punto: la altura sube de 0 a 2,4 en el 80 % del tramo y cae en el 20 % final.
Cuando Python dice "saltó del tramo 10 al 12", la animación lleva el coche hasta la punta de
la rampa y de ahí traza una **parábola** (una curva como la de una pelota lanzada) hasta el
punto de aterrizaje. La altura del arco crece con la distancia del vuelo.

## 4. Cómo se modelan las plataformas suspendidas (el puente)

**La regla:** cada carril tiene **dos pisos**. Además de la fila del suelo (`ground`), hay
una fila del "segundo piso" (`deck`). Donde hay `-` no hay puente; donde hay `P` hay
plataforma; donde hay `G` hay un hueco.

- Al puente **solo se sube saltando** desde la rampa del tramo 10 del carril 4.
- Estando arriba, el coche **ignora lo que hay abajo** (lodo, agua y un foso en el carril 4).
  Ese es el atajo.
- Arriba **no se puede cambiar de carril** (no hay por dónde).
- El hueco `G` del tramo 17 solo se cruza a velocidad 3. Más lento, el coche cae al suelo
  (accidente) y sigue por abajo.
- Cuando la fila del segundo piso se acaba (`-`), el coche **baja al suelo** solo.

Por eso la observación incluye "suelo o puente": en el mismo tramo y carril, estar arriba o
abajo son situaciones completamente distintas.

**El dibujo:** cada casilla `P` es una losa a 2,8 de altura con un pilar que baja al suelo.
Las casillas `G` simplemente no tienen losa (se ve el hueco). Es la misma función `strip`
de las rampas, pero con altura fija arriba y abajo.

## 5. La cámara que sigue al coche

**¿Existe una librería?** Three.js **no trae** una "cámara de seguimiento" lista. Trae
`OrbitControls` (la que ya usaban para girar con el mouse), que sirve para mirar, no para
perseguir. Las opciones son:

- **Programarla (lo que hicimos):** son unas 15 líneas. En cada cuadro se calcula un "punto
  ideal" para la cámara (por ejemplo, 15 unidades detrás del coche y 7 arriba) y la cámara
  **se acerca poco a poco** a ese punto en vez de saltar ahí (eso se llama suavizado o
  *lerp*). El resultado es que la cámara "persigue" al coche con un pequeño retraso, como
  en los videojuegos.
- **`camera-controls`** (librería de yomotsu para Three.js): da transiciones suaves de
  cámara ya hechas. Sirve, pero para este caso no hacía falta otra dependencia.
- En motores de videojuego existen herramientas dedicadas (Cinemachine en Unity, Spring Arm
  en Unreal), pero no aplican a una página web con Three.js.

**Los 4 modos de la web:**

| Botón | Qué hace |
|---|---|
| Seguir coche | Cámara detrás y arriba del coche, mirando hacia adelante |
| Lateral (Excitebike) | Cámara al lado de la pista, desde adentro del óvalo, mirando hacia la tribuna: como la imagen de referencia |
| Vista aérea | Toda la pista desde arriba |
| Libre | Se controla con el mouse (arrastrar para girar, rueda para acercar) |

## 6. Recompensa (reward v3)

| Evento | Puntos |
|---|---|
| Cada paso | −1 (para que no se demore) |
| Cada tramo nuevo avanzado | +2 (solo la primera vez; si retrocede y vuelve, no repite) |
| Cada unidad de combustible gastada | −0,05 |
| Cada accidente | −8 |
| Llegar a la meta | +20 y +0,1 por cada unidad de combustible que le sobre |

El episodio termina al llegar a la meta, al cuarto accidente o sin combustible (150 al
inicio). Si nada de eso pasa, se corta a los 100 pasos (*truncated*, no *terminated*).

## 7. Resultados

Q-learning tabular, 4.000 episodios por semilla, 3 semillas (7, 21 y 42), evaluación con la
política congelada (sin exploración) en una suite fija de 40 episodios, la misma para todos
(`rally-v3-suite-1`).

**Hipótesis (escrita antes de entrenar):** el agente lograría al menos 90 % de vueltas
completas y superaría a la política de reglas por más de 30 puntos de retorno.

| Política | Éxito | Retorno medio | Pasos | Accidentes |
|---|---|---|---|---|
| Aleatoria | 8 % | −17,7 | 35,1 | 1,77 |
| Reglas escritas a mano | 53 % | +0,8 | 39,1 | 0,47 |
| **Q-learning (media de 3 semillas)** | **100 %** | **+65,4** | **13,6** | **0,00** |

**Decisión: candidato aceptado** (100 % de éxito y +64,6 sobre las reglas). La variación
entre semillas es muy pequeña (desviación del retorno ≈ 0,3): el ambiente es determinista y
las tres semillas aprenden rutas parecidas. Salgan del carril que salgan, todas se pasan al
carril 4, saltan la rampa con barril (tramo 6) y la del tramo 10, aterrizan en el puente,
cruzan el hueco a toda velocidad y saltan otra rampa en el tramo 22. Las semillas 7 y 21
además saltan la última rampa (tramo 28) para llegar antes a la meta.

**¿Por qué las reglas fallan tanto?** La regla "salta las rampas a toda velocidad" funciona
en el carril 4, pero en el carril 3 la rampa es una trampa (cae en agua o en un foso). Una
regla fija no sabe distinguirlas; el agente lo aprende con la experiencia.

## 8. Incidente controlado: la lluvia (lo que pide la sección 14 de la guía)

**La perturbación:** aparecen charcos y barro nuevos, justo en la ruta que usa el coche
(`perturbations.lluvia` en la configuración).

**Degradación:** con lluvia, el modelo original pasa de 100 % a **0 %** de vueltas completas.
La razón es muy clara en la reproducción: el coche llega frente a un charco que **nunca vio
durante el entrenamiento**. Para él es una situación nueva sin experiencia (su fila de la
tabla está en cero), así que elige siempre la primera acción (frenar) y se queda quieto
hasta que se acaba el combustible.

**Dos intervenciones, misma regla para aceptarlas** (fijada antes): bajo lluvia debe tener
éxito ≥ 90 % y al menos el 90 % del retorno original, **y** en la pista normal debe seguir
con éxito ≥ 90 %.

| Intervención | Con lluvia | Pista normal | Decisión |
|---|---|---|---|
| A · reentrenar solo con lluvia | 100 % · +66,0 | **0 %** · −36,4 | **Rechazada**: aprende la lluvia pero se "olvida" de la pista normal |
| B · reentrenar con clima mixto (50 % de los episodios con lluvia) | 100 % · +65,0 | 100 % · +63,8 | **Aceptada** |

Se promueve la B. Las dos quedan registradas (con `parent_run_id` apuntando al modelo
original), como pide la guía: también se conservan los intentos que no mejoraron.

## 9. Cómo ejecutarlo

```bash
source .venv/bin/activate
uv pip install -r requirements.txt

# Pruebas de reglas (23 pruebas del N3 + las del N2)
python -m unittest tests.test_rally_v3 tests.test_rally_v2

# Corrida oficial: 3 semillas + referencias + lluvia + intervenciones A y B,
# con DVC y MLflow (experimento "autonomous-rally-v3")
PREFECT_SERVER_EPHEMERAL_ENABLED=true python run_experiment.py --environment-version rally-v3

# Prueba rápida sin DVC ni MLflow (no cuenta como corrida oficial)
python pipeline_v3.py --skip-tracking --episodes 300 --seeds 7

# Ver la web
python3 -m http.server 8000 --directory rally-dashboard/dist
# abrir http://localhost:8000/v3.html
```

Enlaces directos a un momento concreto, útiles en la sustentación:
`v3.html?seed=7&escenario=lluvia-original` (el coche congelado frente al charco),
`v3.html?seed=21&escenario=A-normal` (la intervención A que olvidó la pista),
`v3.html?seed=7&escenario=eval-1&paso=6&pausa` (aterrizando en el puente).

Cada corrida produce, sin sobrescribir nada anterior:

- `data/experiments/rally-v3-<uuid>/transitions.csv` (+ su `.dvc`), con una columna `weather`
- `models/rally-v3-<uuid>/`: tabla Q, `config.json`, `metadata.json`, **`manifest.json`**
  (con los campos de la plantilla de la sección 11 de la guía), métricas, evaluación y README
- `reports/rally-v3-<uuid>.json`: semillas, referencias, criterio de selección, incidente y decisión
- `rally-dashboard/dist/v3-results.json`: lo que reproduce la web

## 10. Archivos nuevos o modificados

| Archivo | Qué es |
|---|---|
| `configs/rally-v3.json` | **Todas** las reglas: carriles, terrenos, rampas, puente, recompensa, lluvia, hipótesis y criterios |
| `race_env_v3.py` | El ambiente Gymnasium (`reset` / `step`) |
| `training_v3.py` | Q-learning, referencias (aleatoria y de reglas), evaluación y paquete del modelo |
| `pipeline_v3.py` | Flujo Prefect: entrenar → DVC → MLflow → criterio → incidente → informe |
| `tests/test_rally_v3.py` | 23 pruebas de reglas, reproducibilidad y que v1/v2 no cambiaron |
| `rally-dashboard/dist/v3.html`, `app-v3.js`, `scene-v3.js`, `track-v3.js`, `v3.css` | La web del N3 |
| `environments.py`, `run_experiment.py` | Se añadió `rally-v3` al selector (v1 y v2 siguen igual) |
| `index.html`, `v2.html` | Solo se añadió el enlace "Experimento 3" al menú |

## 11. Límites (para decirlos con honestidad en la defensa)

- Es un mundo **discreto** (casillas de 100 m, velocidad 0-3), no física continua. Un salto
  es "vuela 2 o 3 casillas", no una trayectoria calculada con gravedad. La parábola de la web
  es solo visual.
- La política es **tabular**: no generaliza a situaciones que no vio (eso es justamente lo
  que muestra el incidente de lluvia). Una red neuronal con PPO podría generalizar mejor;
  sería la siguiente hipótesis razonable.
- Después de un accidente el coche vuelve un tramo atrás aunque ese tramo sea un foso (no
  vuelve a contar como accidente porque no "entra" al foso; es una simplificación).
- Los datos que trae ahora `v3-results.json` se generaron con `--skip-tracking` (sin DVC ni
  MLflow). **Hay que correr la versión oficial** en el computador del equipo para que queden
  los registros en MLflow y los punteros DVC (ver sección 9).

## 12. Qué falta frente al enunciado del profe

Esto ya no es del experimento 3, sino del proyecto completo:

- **Despliegue en Vercel** (sección 16): todavía no hay URL publicada.
- **Remoto de DVC y MLflow compartido**: siguen locales, así que el profe no puede
  recuperar datos ni ver el historial desde otro computador.
- **Cargar un modelo y evaluarlo desde la web**: hoy la web *reproduce* corridas guardadas.
  La guía pide que el docente pueda cargar un modelo histórico y ejecutar una evaluación
  (con una API, por ejemplo FastAPI, o con el ambiente corriendo en el navegador).
- **Vite + TypeScript**: la guía los sugiere para la web; el proyecto usa JavaScript sin
  compilar en `rally-dashboard/dist`. Funciona, pero conviene justificarlo o migrarlo.
- **PPO**: la guía lo pone como referencia. Q-learning está permitido si se justifica
  (estados y acciones discretos y pequeños, como aquí); conviene dejarlo escrito en el informe.
