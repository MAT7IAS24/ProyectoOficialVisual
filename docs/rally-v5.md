# Experimento 5 · rally-v5 / reward v5 (nivel N5) · "Un coche que se comporta como coche"

Código: `race_env_v5.py`, `training_v5.py`, `pipeline_v5.py`, `configs/rally-v5.json`,
pruebas `tests/test_rally_v5.py`, web `rally-dashboard/dist/v5.html`. El N4 sigue intacto
(sus archivos están protegidos por una prueba con su huella SHA-256).

## 1. Por qué este experimento

Al ver las carreras del N4 notamos dos cosas que no pasan en la vida real:

1. **En el barro el coche "se iba de lado"**: cruzaba el barro en diagonal, con 12° en promedio
   respecto a la pista (medido con las reglas en las 30 pistas de la suite). Un carro real en barro
   se pone lento y pesado, y las ruedas hundidas siguen los surcos: no se desliza de lado solo.
2. **El coche siempre iba exactamente hacia donde apuntaba**, giraba al instante y nunca derrapaba.
   Era un modelo "cinemático": bueno para empezar, pero poco realista.

La investigación (`claude/investigacion-coches-ia.md` en el proyecto) mostró que los proyectos
serios de coches con IA (Gran Turismo Sophy, AutoRally, F1TENTH) usan un **modelo dinámico con
llantas de Pacejka**. El N5 hace ese cambio, con la misma suite de 30 pistas del N4 para comparar.

**Hipótesis (escrita antes de entrenar):** con llantas realistas, volante y pedal graduales y barro
con surcos, (1) el ángulo de avance en el barro baja de 12° a **menos de 3°**, y (2) las reglas
conservan **al menos el 80 %** de vueltas completas y PPO **no empeora más de 5 puntos** frente al
N4 (20 %).

## 2. Las variables nuevas, una por una

Todas se calculan en Python cada **0,025 s** (10 subpasos por cada decisión de 0,25 s) y se
guardan en la reproducción que dibuja la web.

### Velocidad hacia adelante y de lado: `vx` y `vy` (m/s)
Antes había una sola velocidad. Ahora se mide en el sistema del coche: `vx` es hacia la trompa y
`vy` hacia el costado izquierdo. Si `vy` no es cero, el coche se está deslizando de lado.
**Cómo se mide:** se integran las fuerzas: velocidad nueva = velocidad + (fuerza ÷ masa) × 0,025 s,
con masa de **1.250 kg**.

### Deslizamiento de la carrocería: β (grados)
Es el ángulo entre **hacia dónde apunta** el coche y **hacia dónde se mueve**: β = atan(vy ÷ vx).
En una curva normal es de 0 a 3°; más de 6° ya es un derrape (evento `derrapa`) y más de **70°**
es un trompo (cuenta como accidente). En la web es la aguja "DESLIZAMIENTO".

### Giro con inercia: `r` (rad/s) y momento de inercia (kg·m²)
Antes el coche rotaba al instante. Ahora el giro cambia según el "par" que hacen las llantas
(fuerza × distancia al centro de gravedad) dividido por la **inercia de giro (1.900 kg·m²)**: igual
que cuesta empezar a girar una puerta pesada. Por eso el coche tarda un poco en entrar a la curva.

### Ángulo de deslizamiento de cada llanta: α (rad)
Una llanta que rueda derecho no empuja de lado. Si el eje se mueve un poco de costado respecto a
hacia dónde apunta la rueda, aparece un ángulo α y la goma se deforma y empuja. Se calcula para el
eje delantero (que además tiene el volante) y el trasero.

### La "fórmula mágica" de Pacejka
Convierte α en fuerza lateral:
`F = agarre × peso del eje × sin(C · atan(B·α − E·(B·α − atan(B·α))))`, con B = 9 adelante y
11 atrás, C = 1,8, E = 0,95. La fuerza crece con α hasta un **máximo** (agarre × peso) y después se
**satura**: si se pide más, la llanta resbala. Es la fórmula que usan los juegos de carreras y los
ingenieros (por eso se llama "mágica": ajusta muy bien los datos reales con 4 números).
Atrás es un poco más rígida (B = 11) para que el coche sea estable y tienda a enderezarse.

### Peso de cada eje (N)
El centro de gravedad está a 1,25 m del eje delantero y 1,45 m del trasero (2,70 m entre ejes), así
que adelante carga 6.590 N y atrás 5.680 N. El agarre de cada eje es agarre del suelo × su peso.

### Círculo de agarre
Acelerar o frenar y girar **comparten** el mismo agarre:
`lateral disponible = √(agarre_máx² − fuerza_longitudinal²)`. Si las ruedas usan casi todo para
acelerar, casi no queda para girar. Lo vimos en la lluvia: acelerar a fondo en una curva mojada
hacía que la cola se fuera (sobreviraje por potencia) y el coche hacía un trompo, como en la vida
real. Por eso la política de reglas ahora tiene un "control de tracción" (no pide más del 60 %
del agarre para acelerar o frenar).

### Tracción y frenos repartidos (fracción)
Tracción en las 4 ruedas, mitad y mitad; frenos 60 % adelante. Si se pide más fuerza de la que da
el agarre aparecen los eventos `patina_al_acelerar` o `bloquea_los_frenos`.

### Volante y pedal graduales (rad/s, 1/s)
La acción del agente ahora es una **orden**: el volante real gira como máximo **1,2 rad/s (69°/s)**
hasta un tope de **0,40 rad (23°)**, y el pedal llega a fondo en **0,2 s**. Si se suelta el volante,
vuelve al centro. (F1TENTH encontró que modelar este retraso fue clave para que lo aprendido sirva
en un coche real.) En la telemetría se ven las dos barras: "pedido" y "real".

### Barro con surcos: arrastre lateral `plow` (fracción del peso)
El barro tiene tres efectos:
1. **Agarre 0,45**: se puede acelerar poco.
2. **Resistencia a la rodadura 0,22**: frena 0,22 × 9,81 ≈ **2,2 m/s² por segundo** sin tocar el freno.
3. **Surcos (`plow` = 0,55)**: las ruedas hundidas van por surcos que siguen la pista. Se oponen a
   moverse de lado **respecto a la pista** con una fuerza de hasta 0,55 × el peso, y hacen un par que
   endereza el coche. Por eso en el barro el coche se pone lento pero no se va de lado, y cambiar de
   carril dentro del barro cuesta mucho más.

| Terreno | Agarre | Rodadura | Surcos | Qué se siente |
|---|---|---|---|---|
| Asfalto (toda la pista) | 1,00 | 0,015 | 0 | Agarre total |
| Barro | 0,45 | 0,22 | 0,55 | Lento, pesado, derecho |
| Agua | 0,35 | 0,04 | 0 | Resbala: aquí sí se derrapa |
| Pasto | 0,55 | 0,08 | 0,10 | Frena un poco y resbala algo |

### Nuevas lecturas del agente (observación de 140 números)
A los 134 del N4 se suman 6: velocidad lateral (÷ 5 m/s), giro (÷ 1 rad/s), volante real
(÷ 0,40 rad), pedal real, deslizamiento β (÷ 0,5 rad) y agarre bajo las ruedas.

### Q-learning y el ruido de los sensores (arreglo)
En el N4 la tabla leía la velocidad y el rumbo exactos del simulador: el "sensor ruidoso" no la
afectaba. Ahora, con ruido, la tabla también lee velocidad, rumbo y posición con ruido.

## 3. Qué se ve nuevo en la web

* **Asfalto en toda la pista** (textura generada en el navegador), líneas pintadas: bordes blancos,
  separadores discontinuos y eje central amarillo; **línea de meta a cuadros**; **conos** en las
  curvas y la salida; **pianos** rojo y blanco solo en las curvas; banquina de grava.
* **Ruedas delanteras que giran** con el ángulo real del volante.
* **Marcas de llanta** cuando el coche desliza más de 6° o patina, **surcos y salpicaduras** de barro
  y **spray** en el agua.
* **Indicador de deslizamiento** (aguja) y telemetría de volante, giro y agarre.
* Escenario **"Antes (N4) y ahora (N5)"**: las mismas reglas en la misma pista, con la física vieja
  (coche azul) y la nueva (amarillo).
* Cámara que sigue la dirección de **movimiento** (en un derrape se ve el coche cruzado).
* Corrección: en el N4 el modelo 3D se veía girado en las curvas (la fórmula del ángulo tenía un signo
  invertido); en el N5 está corregida.

## 4. Recompensa (reward v5)

Igual que v4 (+0,05 por metro, +0,5 por checkpoint, −0,02 por paso, −5 por accidente, −10 si se
atasca, +30 al terminar y +0,2 por litro sobrante). Cambia lo que cuenta como accidente: **el trompo**.
Por eso es `reward v5`.

## 5. Resultados

Corridas sin DVC ni MLflow (`--skip-tracking`), 3 semillas (7, 21, 42), 1 millón de pasos por
modelo, evaluadas en las **mismas 30 pistas del N4** que nunca se usaron para entrenar.

### Resultado de la hipótesis

| Criterio (fijado antes de entrenar) | Meta | N4 | Intento 1 | Intento 2 | ¿Cumple? |
|---|---|---|---|---|---|
| Diagonal al cruzar el barro (reglas) | < 3° | 12,1° | 2,7° | 2,7° | Sí |
| Velocidad de lado en el barro (reglas) | — | 2,5 m/s | 0,5 m/s | 0,5 m/s | — |
| Vueltas completas · reglas | ≥ 80 % | 87 % | 87 % | 87 % | Sí |
| Vueltas completas · PPO (media de 3 semillas) | ≥ 15 % | 20 % | **0 %** | **10 %** | No |

**Veredicto: RECHAZADO.** La parte de física se confirmó: el coche ya no cruza el barro en
diagonal y las reglas manejan igual de bien. La parte de aprendizaje no: PPO quedó por debajo
de la meta en los dos intentos.

### Intento 1 (6 nov · commit `9d3c8d1` · informe `reports/rally-v5-132e21c5….json`)

PPO 0 % en las 3 semillas, Q-learning 2 %, 3,4 accidentes por vuelta. Diagnóstico:

* PPO manejaba "todo o nada": acelerador a fondo el **46 %** del tiempo y volante a tope el **32 %**.
  En el N4 eso funcionaba porque el coche iba siempre hacia donde apuntaba; con llantas reales
  hace derrapar y salirse de la pista (la mayoría de los accidentes fueron `sale_de_la_pista`).
* Llegó a 20–40 % a mitad del entrenamiento (semilla 21: 40 % a los 450 mil pasos) y después lo
  olvidó, pero se guardaba siempre el modelo del final.

### Intento 2 (7 nov · informe `reports/rally-v5-e7e8a036….json`)

Misma pista, física, recompensa y suite. Solo cambió cómo aprende y se elige el modelo:

1. **Pistas de validación**: 10 pistas aparte (semillas 200000…) que no son ni de entrenamiento
   ni del examen. Cada 50 mil pasos se prueba el modelo ahí y **se guarda el mejor punto**.
2. **Tasa de aprendizaje que baja en línea recta hasta 0**, para que al final no "olvide".
3. El **modelo recomendado** también se elige por validación, no por el examen.
4. Se probó **exploración suave (gSDE)** en una prueba corta y **se descartó**: a los 200 mil pasos
   seguía sin completar vueltas (con la exploración normal ya llegaba a 20 % a los 300 mil).

| Política | Normal | Lluvia | Sensores con ruido | Accidentes por vuelta |
|---|---|---|---|---|
| Reglas a mano | 87 % | 80 % | — | 0,77 |
| PPO (semillas 7 / 21 / 42) | 10 % (17 / 7 / 7) | 0 % | 0 % | 1,9 (antes 3,4) |
| Q-learning | 6 % (3 / 3 / 10) | 1 % | 6 % | 2,0 |
| Azar | 0 % | — | — | 0,97 |

* PPO mejoró de 0 % a 10 % y bajó los accidentes casi a la mitad, pero sigue sin aguantar la lluvia
  ni el ruido de los sensores.
* El modelo recomendado es **PPO semilla 42** porque fue el mejor en **validación**, aunque en el
  examen la semilla 7 sacó más (17 %). Elegir por el examen sería hacer trampa: así es como se
  hace en MLOps aunque el número se vea peor.
* Deslizamiento medio en asfalto: reglas 0,3°, PPO 5°. PPO todavía maneja "nervioso".

### Qué aprendimos y qué sigue

Con física realista, aprender a manejar desde cero es mucho más difícil: el agente tiene que
descubrir solo que debe frenar antes de la curva y no girar a fondo. Las reglas ya lo saben
(87 %). Esto confirma el plan: en el **N7** el agente recibirá sensores tipo Gran Turismo Sophy
(curvatura adelante según la velocidad) y en el **N8** aprenderá primero imitando a las reglas
(*behavior cloning*) y después mejorará con PPO.

Paquetes publicados en la web: `modelos/n5/ppo-recomendado/` (model.zip, policy.onnx,
normalization.json, manifest.json) y `modelos/n5/qlearning-mejor/` (q_table.npy).

## 6. Cómo ejecutarlo

```powershell
.venv\Scripts\python.exe -m unittest tests.test_rally_v5
$env:PYTHONUTF8="1"; $env:PREFECT_SERVER_EPHEMERAL_ENABLED="true"; $env:DVC_NO_ANALYTICS="1"
.venv\Scripts\python.exe run_experiment.py --environment-version rally-v5
```

Prueba rápida sin DVC ni MLflow: `python pipeline_v5.py --timesteps 20000 --seeds 7 --skip-tracking`.

Para repetir el intento 1: `git checkout 9d3c8d1` y el mismo comando (sin pistas de validación ni
tasa decreciente). El intento 2 es la etiqueta `rally-v5-n5`.

## 7. Límites

* El peso de cada eje es fijo: todavía no se pasa peso adelante al frenar ni de lado en las curvas
  (eso es el N6, junto con la suspensión).
* No hay marcha atrás: el freno detiene el coche pero no retrocede (salir de atascos es el N9).
* El modelo de llanta es "simplificado": usa los mismos B, C, E en todos los terrenos y solo cambia
  el agarre.
