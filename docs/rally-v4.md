# Experimento 4 · rally-v4 / reward v4 (nivel N4)

> **En una frase:** el coche ya no se mueve por casillas. Ahora tiene **física de verdad**:
> velocidad en metros por segundo, frenadas, agarre, giros y saltos con gravedad. Además, **la
> pista cambia en cada carrera**. Comparamos dos cerebros: una **tabla (Q-learning)** y una **red
> neuronal (PPO)**, para ver cuál se adapta mejor a pistas que nunca vio.

Los experimentos 1, 2 y 3 no se tocaron (hay una prueba que lo verifica con huellas SHA-256).

## 1. Por qué este experimento

En el N3 vimos que la tabla Q **no generaliza**: cuando llovió, el coche se congeló frente a
charcos que nunca había visto. El N4 pone esa idea a prueba de frente:

- cada carrera tiene una pista distinta (obstáculos en lugares al azar);
- se evalúa en **30 pistas que jamás se usaron para entrenar**;
- los dos algoritmos reciben **el mismo presupuesto**: 1.000.000 de pasos de simulación.

La guía del profe pide además, para el Rally, **acelerar y girar** como acciones, sensores de
**distancia a los bordes**, **checkpoints en orden** y **PPO de Stable-Baselines3** como
referencia. Todo eso entra en este nivel.

## 2. Las variables nuevas, una por una

Para cada variable: qué es, en qué unidad se mide, qué la calcula y cómo la "ve" el modelo.
Todas las cifras están en `configs/rally-v4.json`.

### Velocidad (m/s)
- **Qué es:** qué tan rápido va el coche. 20 m/s = 72 km/h. Máximo 35 m/s (126 km/h).
- **Cómo se mide:** en cada paso se suma la aceleración por el tiempo:
  `velocidad nueva = velocidad + (acelerar − frenar − resistencia) × tiempo`.
  Es la fórmula de física de colegio (v = v₀ + a·t), calculada con **NumPy/Python** en `race_env_v4.py`.
- **Cómo la ve el modelo:** `velocidad / 35` (un número entre 0 y 1).

### Aceleración y freno (m/s²)
- **Qué es:** el pedal. La acción del agente es un número entre −1 y +1:
  +1 = acelerar a fondo (6 m/s²), −1 = frenar a fondo (9 m/s²).
- **Límite por agarre:** no se puede acelerar ni frenar más de lo que permite el piso:
  `máximo = agarre × 9,81`. En agua (agarre 0,30) solo se logran 2,9 m/s² aunque se pise a fondo.

### Agarre (adimensional, 0 a 1)
- **Qué es:** cuánto "se pega" la llanta al piso (coeficiente de fricción). Tierra 0,90, pasto 0,60,
  lodo 0,55, agua 0,30. Con lluvia todo baja un 30 %.
- **Para qué sirve:** limita acelerar, frenar **y girar**. Si el coche pide un giro más cerrado
  del que permite el agarre, se va de largo (subviraje), como un carro real en una curva mojada.
- **Cómo lo ve el modelo:** por sensores: el agarre de cada una de las 6 celdas de adelante en
  los 4 carriles.

### Resistencia a la rodadura: por qué el lodo "traba"
- **Qué es:** una fuerza que frena sola, aunque no se toque el freno. Se mide como una fracción
  de la gravedad: `frenado = resistencia × 9,81`.
- **Valores:** tierra 0,015 (casi nada), pasto 0,10, **lodo 0,30**.
- **El lodo:** 0,30 × 9,81 = **2,9 m/s² de frenado**. Un coche que entra a 20 m/s y suelta el
  acelerador pierde unos 3 m/s por segundo. Para cruzar 30 m de lodo sin quedarse tiene que
  entrar rápido o seguir acelerando (y eso gasta combustible). La prueba
  `test_mud_brakes_with_rolling_resistance` comprueba ese número.
- **Resistencia del aire:** además, `0,0008 × velocidad²`. A 30 m/s son 0,7 m/s².

### Giro (radianes) y modelo de bicicleta
- **Qué es:** la otra acción, entre −1 y +1; multiplica el ángulo máximo de las ruedas (0,35 rad ≈ 20°).
- **Cómo se calcula el giro del coche:** con el **modelo de bicicleta**, el que se usa en
  vehículos autónomos reales: `cuánto rota por segundo = velocidad ÷ distancia entre ejes × tan(ángulo de ruedas)`,
  con 2,7 m entre ejes. Detenido no puede girar; rápido, un toque de volante lo rota mucho.

### Posición en la pista y distancia a los bordes (m)
- **Qué es:** `s` = metros recorridos sobre la línea central; `d` = metros hacia el centro del
  óvalo (+) o hacia afuera (−). La pista mide 16 m de ancho (4 carriles de 4 m).
- **Distancia a los bordes:** `8 − d` y `8 + d`. Si `|d| > 8`, se sale de la pista (accidente).
- **Cómo la ve el modelo:** posición lateral / 8, y las dos distancias a los bordes divididas por 16.

### Rumbo relativo (rad)
- **Qué es:** cuánto está "torcido" el coche respecto a la dirección de la pista. 0 = derecho.
- **Cómo lo ve el modelo:** rumbo / 0,6.

### Curvatura de la pista (1/m)
- **Qué es:** qué tan cerrada es la curva: 0 en las rectas, 1/80 en las curvas (radio de 80 m).
- **Cómo la ve el modelo:** la curvatura **aquí, a 30 m y a 60 m** (para anticipar la curva).

### Altura, velocidad vertical y gravedad (m, m/s, 9,81 m/s²)
- **Rampa:** sube 1,2 m con un ángulo de **20°**. Al llegar arriba el coche sale disparado:
  `velocidad vertical = velocidad × sen(20°)` y `velocidad horizontal = velocidad × cos(20°)`.
- **En el aire:** solo manda la gravedad: cada 0,05 s la velocidad vertical baja 9,81 × 0,05 = 0,49 m/s.
  No se puede acelerar ni girar en el aire.
- **Distancia del salto:** sale de la física, no está escrita a mano. A 20 m/s vuela unos 29 m;
  a 15 m/s, unos 17 m; a 10 m/s, unos 9 m. Por eso **para saltar un foso de 20 m hay que llegar a más de 17 m/s**.
  La prueba `test_ramp_jump_follows_gravity` compara contra la fórmula del tiro parabólico.
- **Aterrizaje duro:** si cae a más de 12 m/s hacia abajo, es accidente.
- **Cómo lo ve el modelo:** altura / 4, velocidad vertical / 10 y una señal "en el aire" (0 o 1).

### El puente (plataforma suspendida a 3 m)
- Se sube **saltando** desde una rampa. Encima no hay obstáculos (pasa por arriba del lodo, el agua y el foso).
- Tiene un **hueco de 6 m**. Al cruzarlo el coche cae por gravedad: a 24 m/s tarda 0,25 s y baja
  0,3 m (alcanza el otro lado); a 12 m/s tarda 0,5 s y baja 1,2 m (choca contra el borde o cae).
  La regla sale sola de la física: **hace falta ir a más de unos 17 m/s**.
- Si el coche se sale por un costado, cae 3 m (accidente). Al final hay una bajada.
- **Cómo lo ve el modelo:** señal "en el puente" y, en los sensores, dónde hay puente (1) o hueco (−1).

### Vallas (los modelos 3D de vallas)
- Ocupan un carril. Si el coche las toca **frena en seco** (velocidad 0) y rebota 6 m.
  Si iba a más de 6 m/s es accidente; más despacio, solo se detiene.
- **Cómo las ve el modelo:** como "peligro = 1" en los sensores (igual que los fosos).

### Combustible (litros)
- 40 litros al inicio. Gasta 0,08 L/s en ralentí y hasta 0,32 L/s más con el acelerador a fondo.
  Sin combustible el acelerador deja de funcionar. Lo que sobra al llegar da puntos.

### Checkpoints
- Uno cada 50 m (22 por vuelta), en orden, como pide la guía. Cada uno nuevo suma 0,5 puntos.

### Los sensores: cómo "ve" la pista el coche
El coche no ve la pista entera. Ve **6 celdas de 10 m hacia adelante** (60 m) en **los 4 carriles**,
y de cada celda sabe 5 cosas:

| Rasgo | Valor |
|---|---|
| peligro | 1 si hay valla o foso |
| rampa | 1 si hay rampa |
| frena | resistencia del piso ÷ 0,30 (lodo = 1) |
| agarre | agarre ÷ 0,90 (tierra = 1, agua = 0,33) |
| puente | 1 si hay puente encima, −1 si es el hueco |

Son 6 × 4 × 5 = **120 números**, más 14 del coche = **134 números** por paso. Es como un radar
simplificado; un sensor real (lidar o cámara) daría algo parecido después de procesarlo.

## 3. Los dos cerebros

| | Q-learning (tabla) | PPO (red neuronal) |
|---|---|---|
| Librería | NumPy | **Stable-Baselines3 + PyTorch** |
| Qué recibe | 5 datos resumidos (velocidad en 6 rangos, carril, rumbo en 3 rangos, qué hay justo adelante, si está en el aire) = 720 casillas | los 134 números completos |
| Acciones | 15 combinaciones fijas (3 de pedal × 5 de volante) | cualquier valor continuo de pedal y volante |
| Cómo aprende | una casilla de la tabla por situación | una red de 2 capas de 64 neuronas que **generaliza**: situaciones parecidas dan acciones parecidas |
| Qué pierde | posición exacta en el carril, los otros carriles, la curvatura (la guía pide documentarlo) | — |

**PPO en palabras simples:** el coche corre muchas vueltas con un poco de azar. Cada 2.048 pasos
mira qué acciones salieron mejor de lo esperado y ajusta la red para hacerlas un poco más
probables, sin cambiarla demasiado de golpe (eso es el "clip" de PPO). Tiene dos partes: el
**actor** decide el pedal y el volante; el **crítico** estima cuántos puntos se esperan desde
cada situación, para saber si una acción fue mejor o peor de lo normal.

**Normalización:** antes de entrar a la red, cada uno de los 134 números se centra y escala con
su media y desviación (VecNormalize). Esas medias se guardan con el modelo
(`normalization.json`); sin ellas la red no funciona.

## 4. Recompensa (reward v4)

| Evento | Puntos |
|---|---|
| Cada metro nuevo de avance | +0,05 |
| Cada checkpoint (cada 50 m) | +0,5 |
| Cada paso de 0,25 s | −0,02 |
| Accidente | −5 |
| Atascarse (10 s sin avanzar) | −10 y termina |
| Terminar la vuelta | +30, más 0,2 por litro sobrante |

Lo de "atascarse" se agregó porque en la primera prueba PPO aprendió que **quedarse quieto** era
más seguro que arriesgarse (no moverse no daba accidentes). La guía pide penalizar los bloqueos.

## 5. Cómo se empaqueta la red (sección 11 de la guía)

Cada modelo PPO queda en `models/rally-v4-ppo-<id>/` con:

| Archivo | Para qué |
|---|---|
| `model.zip` | pesos de la red **y el estado del optimizador** (para continuar el entrenamiento) |
| `vecnormalize.pkl` y `normalization.json` | medias y varianzas para normalizar las 134 entradas |
| `policy.onnx` | la red exportada para usarla en el navegador, **con la normalización adentro**; se verifica que dé las mismas acciones que SB3 (diferencia < 0,000001) |
| `manifest.json` | commit, huellas SHA-256 de todo, semilla, presupuesto, suite y **contrato**: orden y unidades de las 134 entradas y de las 2 salidas |
| `evaluation.json` | resultado en cada una de las 30 pistas, en cada condición |
| `training_curves.json` | las dos curvas que pide la guía: entrenamiento (con exploración) y evaluación (sin exploración) |
| `README.md` | ficha del modelo (sirve como tarjeta en Hugging Face) |

El PPO recomendado además se registra en el **Model Registry de MLflow** como `autonomous-rally-ppo`.

## 6. Datos versionados (DVC)

En aprendizaje por refuerzo no hay un dataset fijo: los datos se generan jugando. Por eso se
versionan (guía, sección 10) **el generador** (`generate_layout` + configuración), **la suite de
30 pistas de evaluación** (`escenarios_evaluacion.json`) y **los resultados por caso**
(`resultados_por_caso.csv`), todos con DVC.

## 7. Resultados

Corrida `rally-v4-fdd4946a04d948c8b720b802263b99dc` (informe en `reports/`). 3 semillas (7, 21, 42),
1.000.000 de pasos por modelo, evaluación sin exploración en las mismas 30 pistas nunca vistas.

| Política | Condición | Vueltas completas | Avance medio | Accidentes | Tiempo de vuelta |
|---|---|---|---|---|---|
| Azar | normal | 0 % | 5 % | 1,20 | — |
| Reglas a mano | normal | **87 %** | 95 % | 1,60 | 68,6 s |
| Reglas a mano | lluvia | 67 % | 93 % | 3,17 | 72,6 s |
| Q-learning (tabla) | normal | 6 % (±5) | 38 % | 2,21 | 109,6 s |
| **PPO (red neuronal)** | normal | **20 %** (±9) | 56 % | 2,67 | 57,4 s |
| PPO | lluvia | 4 % | 48 % | 3,94 | 55,6 s |
| PPO | sensores con ruido | 10 % | 52 % | 3,19 | 68,9 s |

Por semilla, PPO: 27 %, 10 % y 23 %; Q-learning: 7 %, 10 % y 0 %.

**Decisión: hipótesis NO confirmada.** El criterio fijado antes de entrenar pedía PPO ≥ 70 % y al
menos 30 puntos sobre Q-learning; se obtuvo 20 % y 14 puntos. Se registra igual, como pide la guía.

**Qué sí muestra la evidencia:**
- PPO **generaliza mejor que la tabla**: más del triple de vueltas, 56 % de avance contra 38 %, y
  cuando termina lo hace mucho más rápido (57 s contra 110 s).
- Con este presupuesto **ninguno de los dos aprende a manejar tan bien como las reglas** (87 %).
- La lluvia y el ruido en los sensores bajan a PPO a la mitad o menos: su conducción es frágil.
- **Por qué falla:** 18 de las 30 carreras de PPO terminan "atascado" (10 s sin avanzar), sobre
  todo después de un accidente: vuelve a intentar lo mismo. Solo 4 terminan por demasiados accidentes.
- Nota de equidad: la perturbación "sensores con ruido" no afecta a Q-learning, porque su versión
  discretizada lee el estado del ambiente y no la observación con ruido. Se corrige en el siguiente nivel.

**Siguientes hipótesis (N5):** (1) más presupuesto (la curva de entrenamiento de PPO todavía subía despacio al final, aunque la de evaluación oscila entre 20 % y 40 %);
(2) empezar con lo que hacen las reglas (aprendizaje por imitación) y luego mejorar con PPO;
(3) currículo: primero pistas fáciles y luego difíciles.

El modelo recomendado (PPO semilla 7, `rally-v4-ppo-9e2c4b8847f8457189bb869fb9a8db81`) y la mejor
tabla Q quedan publicados en `rally-dashboard/dist/modelos/n4/` (pesos, normalización, ONNX,
manifiesto, evaluación por pista y curvas), así se recuperan sin depender de ningún computador.

**Importante:** estos números salieron de una corrida con `--skip-tracking` (sin DVC ni MLflow).
Para la evidencia oficial hay que repetirla en el PC del equipo con `run_experiment.py --environment-version rally-v4`
(la física y las semillas son las mismas, así que debe dar resultados equivalentes).

## 8. Cómo ejecutarlo

```powershell
.venv\Scripts\python.exe -m pip install torch==2.9.1 --index-url https://download.pytorch.org/whl/cpu
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m unittest tests.test_rally_v4
$env:PYTHONUTF8="1"; $env:PREFECT_SERVER_EPHEMERAL_ENABLED="true"
.venv\Scripts\python.exe run_experiment.py --environment-version rally-v4
```

Una corrida completa entrena 6 modelos de 1.000.000 de pasos (unos 50 minutos en un PC normal).

## 9. Límites

- La física es 2D más altura (no hay vuelcos ni suspensión). Es suficiente para que el agarre, la
  inercia y la gravedad cambien las decisiones.
- La web reproduce carreras grabadas. La red ya está exportada a ONNX y verificada para correr en
  el navegador; falta conectar una evaluación en vivo (guía, sección 16).
- Las licencias de los modelos 3D están por confirmar en `rally-dashboard/dist/models3d/CREDITOS.md`.
