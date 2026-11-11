# Experimento 7 · rally-v7 (nivel N7) · "Aprender de un maestro"

Código: `race_env_v7.py`, `training_v7.py`, `pipeline_v7.py`, `configs/rally-v7.json`,
pruebas `tests/test_rally_v7.py`, web `rally-dashboard/dist/v7.html` (+ `scene-v7.js`, `venue.js`).
Los niveles N4, N5 y N6 siguen intactos (una prueba revisa su huella SHA-256).

## 0. Resumen del intento 3 (11 nov) · el que quedó como N7

**En pocas palabras.** Antes PPO aprendía solo, a punta de chocar, y casi nunca llegaba a la meta
(N6: 12 %; intentos 1 y 2 de este experimento: 2 % y 9 %). Ahora primero **copia a un maestro** (las
reglas escritas a mano, que terminan el 87 % de las vueltas) y después practica por su cuenta con PPO.
La física, la mirada de piloto, la recompensa (v5) y las 30 pistas del examen son las mismas: lo único
que cambió es la forma de aprender.

### Cómo aprende ahora (4 pasos)

1. **El maestro maneja y el alumno mira.** Las reglas corren 60 carreras; se guarda qué veían los
   sensores y qué hicieron con el volante y el pedal.
2. **El alumno maneja y el maestro corrige** (método DAgger, 8 rondas). El alumno conduce; en cada
   instante se anota qué habría hecho el maestro en ese mismo lugar. Así aprende también a salir de
   los errores que el maestro nunca comete. Usa pistas distintas a las del examen (semillas 300000+).
3. **Calentamiento.** Durante los primeros 40 mil pasos de PPO solo aprende la parte de la red que
   estima "qué tan bien voy" (el crítico); la parte que maneja queda congelada para no dañar lo copiado.
4. **Práctica propia con PPO** (400 mil pasos, pasos pequeños: tasa 5e-5, recorte 0,1, límite KL 0,02).
   Cada 40 mil pasos se prueba en 10 pistas de validación y se guarda el mejor punto (el punto cero es
   "solo imitación").

Detalles técnicos: red 256×256 (antes 64×64); la normalización de los sensores se calcula con los datos
de la imitación y queda congelada; se desactivó la inicialización ortogonal de SB3 (con ella la
imitación bajaba de 83 % a 47 %). Código: `imitate_rules` y `train_ppo` en `training_v7.py`;
parámetros en `configs/rally-v7.json` (`training.imitation`).

### Resultado (3 semillas, mismas 30 pistas del N4 al N6)

| Criterio (fijado antes de entrenar) | Meta | N6 | Intento 2 | **Intento 3** | ¿Cumple? |
|---|---|---|---|---|---|
| Vueltas completas · PPO | ≥ 70 % | 12 % | 9 % | **80 %** (77 / 90 / 73) | Sí |
| Accidentes por vuelta · PPO | < 2,29 | 2,29 | 1,61 | **1,28** | Sí |
| Vueltas completas · reglas | ≥ 80 % | 87 % | 87 % | **87 %** | Sí |

**Veredicto: ACEPTADO** (3 de 3). Informe: `reports/rally-v7-e0b9ad006c6c410bb827baa0e4dd157e.json`.

| Qué mejoró | Qué no mejoró o falta |
|---|---|
| PPO termina 80 % de las vueltas (N6: 12 %) | El alumno no alcanza al maestro: 80 % contra 87 % |
| Choca 1,28 veces por vuelta (N6: 2,29) | Practicar con PPO después de imitar **no sumó**: solo imitando 83 % y 0,98 choques; después de PPO 80 % y 1,28 |
| Con lluvia 58 % (N6: 4 %), sin haber practicado con lluvia | Con sensores con ruido baja a 51 % |
| Vuelta en 70,2 s; el maestro, 70,3 s | Q-learning sigue en 2 % (no recibe maestro) |
| Usó 514 mil pasos en total (antes 1 millón) | El modelo recomendado (semilla 42, elegido en validación) saca 73 %; la semilla 21 saca 90 % |

Lectura honesta: casi todo el salto viene de imitar. PPO, con pasos tan pequeños, mantuvo lo aprendido
pero no lo mejoró. Para el N8 la pregunta es cómo lograr que el alumno supere al maestro.

### Lo nuevo en pantalla

* **Ruedas arregladas.** Causa real: el modelo 3D traía las ruedas delanteras ya giradas y cada rueda
  con una rotación propia guardada; al girarlas sobre eso, se movían hacia todos lados. Ahora se
  enderezan al cargar y giran según la distancia real recorrida. (También corregido en el N6.)
* Polvo café al pisar pasto, salpicadura en el barro, humo blanco cuando las llantas patinan.
* Chispas, humo oscuro y sacudón de cámara al chocar; confeti al cruzar la meta.
* Luces de freno que se encienden cuando la IA frena.
* La línea que siguió cada coche (amarilla: alumno; azul: el otro coche). Se puede apagar.
* Sección "En pocas palabras": qué cambió, qué mejoró y qué no, generada con los datos del informe.
* Carreras nuevas: alumno contra maestro, y antes contra después de tener maestro (PPO del intento 2).

Las secciones siguientes documentan los intentos 1 y 2 (9 y 10 nov), que quedaron rechazados y
guardados en la etiqueta `rally-v7-n7`. El intento 3 es la etiqueta `rally-v7-n7-maestro`.

## 1. Por qué este experimento

En el N5 y el N6 la física quedó realista y las reglas escritas a mano completan el 87 % de las
vueltas, pero PPO se quedó en 10 % y 12 %. Darle más sensores de su propio coche (peso, suspensión)
casi no ayudó. Al ver las carreras se nota por qué: **PPO llega demasiado rápido a las curvas y a los
obstáculos**. Solo veía 60 m adelante y la curvatura a 30 y 60 m; a 100 km/h eso es apenas 2 segundos,
y frenar de 100 a 50 km/h ya toma unos 30 m.

Gran Turismo Sophy (Sony AI, *Nature* 2022), el agente que le ganó a los mejores pilotos humanos de
Gran Turismo, resolvió esto con dos ideas que copiamos:

1. **Mirar por tiempo**: la red recibe puntos de la pista a varios segundos adelante, no a metros fijos.
2. **Una recompensa que castiga lo que un piloto evita**: chocar fuerte y deslizar sin control.

**Hipótesis (escrita antes de entrenar):** si PPO ve la pista como un piloto y la recompensa castiga
más los choques rápidos y el derrape, entonces (1) PPO completa **al menos el 25 %** de las vueltas
en las mismas 30 pistas nuevas (N6: 12 %), (2) **choca menos que en el N6** (2,29 accidentes por
vuelta) y (3) las reglas, con la misma física, conservan **al menos el 80 %**.

## 2. Lo que cambia (y lo que no)

**No cambia:** la física (llantas de Pacejka, peso que se mueve, suspensión), las 30 pistas del examen,
las 10 pistas de validación, 1 millón de pasos, 3 semillas (7, 21, 42) y la forma de elegir el mejor
punto del entrenamiento. Así, si PPO mejora, el cambio se le puede atribuir a la mirada y a la recompensa.

### Mirada de piloto: 8 puntos a 0,5; 1; 1,5; 2; 2,5; 3; 4 y 5 segundos
Para cada tiempo *t*, el punto está a `velocidad × t` metros adelante sobre la línea central (con mínimo
5 m/s para que parado también mire, y máximo 200 m). De cada punto la red recibe 3 números:

| Dato | Cómo se calcula | Escala |
|---|---|---|
| Adelante | distancia al punto en la dirección en que apunta el coche | ÷ 200 m |
| Costado | cuánto se corre el punto hacia la izquierda (+) o derecha (−) del coche | ÷ 20 m |
| Curva | curvatura de la pista en ese punto × radio de la curva (0 en recta, 1 en curva) | — |

A 100 km/h el punto de 5 s queda 140 m adelante; a 30 km/h, 42 m. En la web, **"Ver lo que ve la IA"**
dibuja esos 8 puntos sobre la pista (verdes en recta, naranjas en curva).

### Obstáculos hasta 100 m (antes 60 m)
Las celdas de 10 m con peligro, rampa, frenado, agarre y puente pasan de 6 a 10 por carril.

### Observación: de 146 a 250 números
26 del coche (como el N6) + 24 de la mirada (8 puntos × 3) + 200 de celdas (4 carriles × 10 celdas × 5).

### Recompensa v7 (solo el intento 1; el intento 2 volvió a la v5)
| Componente | v5 (N5 y N6) | v7 (N7) |
|---|---|---|
| Avance | +0,05 por metro nuevo | igual |
| Checkpoint | +0,5 cada 100 m | igual |
| Paso | −0,02 | igual |
| **Accidente** | −5 siempre | **−(5 + 0,01 × velocidad²)**, velocidad en m/s al chocar: a 30 km/h −5,7; a 90 km/h −11,3 |
| **Derrape** | — | **−0,002 por cada grado** de deslizamiento medio del paso por encima de 6° |
| Atascado / meta / combustible | −10 / +30 / +0,2 por litro | igual |

El avance se cuenta sobre el punto más lejano alcanzado (`max_s`), así que no se puede "farmear"
yendo y viniendo (la trampa que aprendió el coche del video de Yosh).

## 3. Arreglos de la web pedidos al ver el N6

* **Ruedas que "se volvían locas"**: a 100 km/h una rueda real da unas 12 vueltas por segundo y, a 60
  cuadros por segundo, se ve temblar o girar al revés (efecto "rueda de carreta"). Ahora el giro
  dibujado por cuadro tiene un tope. Además el ángulo de las ruedas delanteras se suaviza un poco solo
  en el dibujo (≈ 0,1 s); los datos no cambian. Parte del movimiento es real: PPO mueve el volante de
  tope a tope muy seguido (se ve también en "Volante pedido / real").
* **Vallas y arco de meta de lado**: quedaban paralelos a la pista por un giro de 90° que sobraba desde
  el N5. Ahora están cruzados. El arco es nuevo: cartel "SALIDA · META" con cuadros y luces.

## 4. Mejoras visuales

* Sombras más suaves y nítidas (mapa de 4096 × 4096), pasto cortado en franjas como en un estadio y
  manchas grandes para que no se vea repetido.
* Cámara de persecución un poco más lejos y más suave.
* Puntos de la mirada de la IA en 3D (ver arriba).

## 5. Resultados de los intentos 1 y 2

Corridas sin DVC ni MLflow (`--skip-tracking`), 3 semillas (7, 21, 42), 1 millón de pasos por modelo,
mejor punto elegido en 10 pistas de validación, evaluadas en las **mismas 30 pistas del N4 al N6**.

### Resultado de la hipótesis

| Criterio (fijado antes de entrenar) | Meta | N6 | Intento 1 | Intento 2 | ¿Cumple? |
|---|---|---|---|---|---|
| Vueltas completas · PPO (media de 3 semillas) | ≥ 25 % | 12 % | 2 % | **9 %** | No |
| Accidentes por vuelta · PPO | < 2,29 | 2,29 | 2,30 | **1,61** | Sí (intento 2) |
| Vueltas completas · reglas | ≥ 80 % | 87 % | 87 % | **87 %** | Sí |

**Veredicto de los intentos 1 y 2: RECHAZADO** (2 de 3 en el intento 2; la meta entonces era 25 %). PPO choca menos, pero no llega más veces a la meta.

### Intento 1 (9 nov · commit `856f0ff` · informe `reports/rally-v7-b8fac7f9….json`)

Mirada de piloto **y** recompensa v7 al mismo tiempo. PPO 2 % (0 / 7 / 0), Q-learning 4 %.

* PPO **no se quedó quieto**: avanzó en promedio el 34 % de la vuelta y siguió chocando (37 vallas,
  21 salidas de pista y 5 trompos por cada 30 pistas).
* Chocó más despacio (32 km/h en promedio): la recompensa v7 sí le enseñó a bajar la velocidad, pero
  no a esquivar.
* Error de método: se cambiaron dos cosas a la vez, así que no se podía saber cuál empeoró a PPO.

### Intento 2 (10 nov · informe `reports/rally-v7-cbe88188….json`)

Misma mirada de piloto, pero con la **recompensa del N6** (accidente −5 fijo, sin castigo por derrape;
en la configuración, `accident_per_v2` y `slip_per_deg` valen 0 y `reward_version` es `v5`).

| Política | Normal | Lluvia | Sensores con ruido | Accidentes por vuelta | Velocidad al chocar |
|---|---|---|---|---|---|
| Reglas a mano | 87 % | 87 % | — | 0,70 | 32 km/h |
| PPO (semillas 7 / 21 / 42) | 9 % (0 / 17 / 10) | 1 % | 0 % | 1,61 (N6: 2,29) | 36 km/h |
| Q-learning | 2 % (0 / 0 / 7) | 6 % | 16 % | 2,61 | 42 km/h |

* **La recompensa v7 era lo que más perjudicaba**: al quitarla, PPO pasó de 2 % a 9 %.
* **La mirada sola no alcanza**: 9 % queda por debajo del 12 % del N6. Con 250 números de entrada
  (antes 146) y el mismo millón de pasos, la red tiene más que aprender con la misma experiencia.
* Lo bueno: PPO choca **un 30 % menos** que en el N6 (1,61 contra 2,29 por vuelta).
* Mucha diferencia entre semillas (0 %, 17 %, 10 %): el resultado todavía depende de la suerte.
* El modelo recomendado es **PPO semilla 42** (el mejor en validación; en el examen la 21 sacó más).

### Qué aprendimos y qué sigue

1. Cambiar una sola cosa por experimento. El intento 1 mezcló dos cambios y hubo que repetir.
2. Castigar más los choques no enseña a evitarlos: enseña a chocar despacio.
3. Ver más lejos no basta si el agente tiene que descubrir desde cero qué hacer con esa información.
   Las reglas, con esa misma física, completan el 87 %. Eso se hizo en el **intento 3** (sección 0): PPO empieza imitando a las reglas.

Paquetes publicados en la web: `modelos/n7/ppo-recomendado/` (model.zip, policy.onnx,
normalization.json, manifest.json) y `modelos/n7/qlearning-mejor/` (q_table.npy).

## 6. Cómo ejecutarlo

```powershell
.venv\Scripts\python.exe -m unittest tests.test_rally_v7
$env:PYTHONUTF8="1"; $env:PREFECT_SERVER_EPHEMERAL_ENABLED="true"; $env:DVC_NO_ANALYTICS="1"
.venv\Scripts\python.exe run_experiment.py --environment-version rally-v7
```

Prueba rápida sin DVC ni MLflow: `python pipeline_v7.py --timesteps 20000 --seeds 7 --skip-tracking`.

Para repetir el intento 1 (recompensa v7): `git checkout 856f0ff` y el mismo comando. El intento 2 es
la etiqueta `rally-v7-n7`; el intento 3, `rally-v7-n7-maestro`.

## 7. Límites

* Q-learning no recibe la mirada nueva: su tabla sigue teniendo 720 estados (meterle 24 números más
  la haría imposible de llenar). Sirve de referencia, no compite en igualdad.
* La mirada usa la línea central de la pista, no la trazada ideal (Sophy usa los bordes de la pista).
