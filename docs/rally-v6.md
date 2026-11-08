# Experimento 6 · rally-v6 / reward v5 (nivel N6) · "Peso, suspensión y coche nuevo"

Código: `race_env_v6.py`, `training_v6.py`, `pipeline_v6.py`, `configs/rally-v6.json`,
pruebas `tests/test_rally_v6.py`, web `rally-dashboard/dist/v6.html`. El N4 y el N5 siguen intactos
(sus archivos están protegidos por una prueba con su huella SHA-256).

## 1. Por qué este experimento

En el N5 el coche ya derrapaba y el barro ya no lo empujaba de lado, pero el peso de cada eje era
fijo: al frenar la trompa no se hundía, en las curvas la carrocería no se inclinaba y al caer de un
salto el coche "aterrizaba" sin suspensión. En un coche real eso cambia cuánto agarra cada llanta,
y por eso frenar en plena curva puede hacer que la cola se vaya.

La investigación (`claude/investigacion-coches-ia.md`) mostró que los simuladores serios (Gran
Turismo, AutoRally, BeamNG) calculan el peso de cada rueda en cada instante. El N6 hace ese cambio
y cambia el coche 3D por uno de rally.

**Hipótesis (escrita antes de entrenar):** con transferencia de peso, suspensión, sensibilidad de la
llanta a la carga y aterrizajes con suspensión, (1) el coche pasa dos **pruebas de banco** como un
coche real: frenar a fondo desde 100 km/h hunde la trompa **entre 1° y 3°** y una curva constante
de unos 0,9 g inclina la carrocería **entre 2° y 5°**; (2) las reglas, reajustadas a la nueva
física, conservan **al menos el 80 %** de vueltas completas; y (3) PPO, que ahora también siente el
peso (6 sensores nuevos), **supera el 10 % del N5 y llega al menos al 15 %** en las mismas 30 pistas.

## 2. Las variables nuevas, una por una

Todas se calculan en Python cada **0,025 s** y se guardan en la reproducción que dibuja la web.

### Altura del centro de gravedad (0,50 m) y trocha (1,55 m)
Cuanto más alto está el peso y más angosto es el coche, más peso se pasa de un lado al otro.
**Transferencia hacia adelante** = masa × aceleración × 0,50 ÷ 2,70 (distancia entre ejes).
**Transferencia hacia afuera** = masa × aceleración lateral × 0,50 ÷ 1,55. El 55 % de la
transferencia hacia afuera la lleva el eje delantero (eso hace que el coche tienda a irse de
trompa antes que de cola, como la mayoría de los coches de calle).

### Cabeceo (grados, + = trompa abajo) y balanceo (grados, + = inclinado a la derecha)
Son los ángulos de la carrocería. No cambian de golpe: cada uno es un **resorte con amortiguador**
(cabeceo 1,5 Hz, balanceo 1,3 Hz, amortiguación 0,6). La suspensión "decide" cuándo llega el peso:
por eso al frenar el peso pasa adelante en unas décimas de segundo, no al instante.
Cuánto se inclina: 0,0035 rad (0,2°) de cabeceo y 0,0070 rad (0,4°) de balanceo por cada m/s².

### Peso de cada rueda (fracción del peso total: DI, DD, TI, TD)
Sale de sumar el peso en reposo (54 % adelante, 46 % atrás) más las dos transferencias. Si una
rueda queda con menos del **5 %** de su peso normal, **se levanta** (evento `levanta_una_rueda`).
En la web es el dibujo del coche visto desde arriba: cada círculo crece con el peso de su rueda.

### Sensibilidad a la carga (0,15)
Una llanta con el doble de peso NO agarra el doble: agarra un 15 % menos de lo proporcional.
`agarre de la llanta = agarre del suelo × peso × (1 − 0,15 × (peso ÷ peso normal − 1))`.
Consecuencia: cuando el peso se pasa a un lado, el eje entero pierde un poco de agarre.

### Frenos que siguen al peso (EBD)
En el N5 el freno era 60 % adelante siempre. Ahora cada eje frena según el peso que lleva en ese
momento (entre 50 % y 85 % adelante), como el reparto electrónico de los coches modernos. Sin esto,
al frenar la cola liviana se bloqueaba y las reglas bajaban a 53 %.

### Suspensión al aterrizar: compresión (m) y recorrido (0,30 m)
En el aire los resortes se estiran. Al tocar el suelo reciben la velocidad de caída: se comprimen
(más peso y más agarre un instante) y luego rebotan (1,6 Hz). Si la compresión llega a 0,30 m el
coche **golpea los topes** (evento, no accidente). Caer a más de 12 m/s sigue siendo
`aterrizaje_duro` (accidente), igual que en el N5. En el aire la trompa va girando hacia abajo
para caer paralela a la trayectoria.

### Nuevas lecturas del agente (observación de 146 números)
A los 140 del N5 se suman 6: peso adelante y peso afuera (−1 a 1), cabeceo (÷ 0,05 rad), balanceo
(÷ 0,08 rad), compresión (÷ 0,30 m) y deslizamiento de la llanta trasera (÷ 0,15 rad).

## 3. Las reglas se reajustaron (sin entrenar nada)

Con las ganancias del N5, las reglas solo completaban el **53 %** (frenaban girando y la cola se
iba). Se probaron 9 variantes en las 30 pistas de la suite y se eligió la mejor:

| Ganancia del volante | N5 | N6 |
|---|---|---|
| Corrección lateral (por metro de error) | 0,06 | 0,06 × mín(1, 10 m/s ÷ velocidad) |
| Corrección del rumbo real (rumbo + deslizamiento) | 0,6 | 0,9 |
| Amortiguación del giro | 0,12 | 0,35 |
| Vueltas completas · normal / lluvia | 53 % / 27 % | 87 % / 87 % |

Soltar el freno al girar (1,5 y 3) se probó y empeoró: se descartó.

## 4. Pruebas de banco

`bench_tests()` en `training_v6.py`, en una pista de asfalto sin obstáculos:

1. **Frenada a fondo desde 100 km/h** (en línea recta): distancia, cabeceo máximo y peso que queda atrás.
2. **Curva constante** a 54 km/h con el volante fijo: aceleración lateral (g), balanceo y peso afuera.
3. **Caída desde un salto a 6 m/s**: compresión máxima de la suspensión.

## 5. Qué se ve nuevo en la web

* **Coche de rally nuevo** ("Lowpoly WRC rally car", Amon99, CC BY 4.0) con ruedas que giran y
  viran sobre su propio eje. Si el archivo no está, se usa el coche del N4.
* La **carrocería se inclina sobre las ruedas**: trompa abajo al frenar, hacia afuera en las curvas,
  se hunde al aterrizar. Opción **"Exagerar inclinación ×3"** para verlo en una exposición (los
  datos no cambian).
* Telemetría: **peso en cada rueda** (vista desde arriba), cabeceo, balanceo y suspensión.
* Escenario **"Antes (N5) y ahora (N6)"**: las mismas pistas con la física del N5 (azul) y la del N6.

## 6. Recompensa

No cambia: sigue siendo `reward v5` (la del N5).

## 7. Resultados

Corrida sin DVC ni MLflow (`--skip-tracking`), 3 semillas (7, 21, 42), 1 millón de pasos por
modelo, mejor punto elegido en 10 pistas de validación, evaluadas en las **mismas 30 pistas del N4
y del N5**. Informe: `reports/rally-v6-fa67dfc239f942bcb167518766d7aeea.json`.

### Resultado de la hipótesis

| Criterio (fijado antes de entrenar) | Meta | N5 | N6 | ¿Cumple? |
|---|---|---|---|---|
| Frenada a fondo desde 100 km/h: cabeceo | 1°–3° | 0° (no existía) | **2,1°** | Sí |
| Curva constante a 0,9 g: balanceo | 2°–5° | 0° (no existía) | **3,5°** | Sí |
| Vueltas completas · reglas | ≥ 80 % | 87 % | **87 %** | Sí |
| Vueltas completas · PPO (media de 3 semillas) | ≥ 15 % | 10 % | **12 %** | No |

**Veredicto: RECHAZADO** (3 de 4 criterios). La física se comporta como un coche real y las reglas
reajustadas manejan igual que en el N5, pero PPO mejoró solo 2 puntos.

### Pruebas de banco

| Prueba | Resultado | Qué significa |
|---|---|---|
| Frenada 100 → 0 km/h | 42,7 m | Coche de calle con buenas llantas: 36–45 m |
| Cabeceo máximo al frenar | 2,1° | La trompa se hunde |
| Peso atrás al frenar | 27 % (en reposo 46 %) | La cola queda liviana: por eso frenar girando es peligroso |
| Curva constante | 0,9 g, balanceo 3,5° | La carrocería se inclina hacia afuera |
| Peso en las ruedas de afuera | 79 % | Las de adentro casi se levantan |
| Caída a 6 m/s | compresión 25 cm de 30 | No golpea los topes |

### En las 30 pistas

| Política | Normal | Lluvia | Sensores con ruido | Accidentes por vuelta |
|---|---|---|---|---|
| Reglas a mano | 87 % (N5: 87 %) | 87 % (N5: 80 %) | — | 0,70 |
| PPO (semillas 7 / 21 / 42) | 12 % (17 / 7 / 13) | 4 % (N5: 0 %) | 0 % | 2,3 |
| Q-learning | 2 % (0 / 0 / 7) | 6 % | 10 % | 2,6 |
| Azar | 0 % | — | — | 0,93 |

* **PPO mejoró poco pero en todas partes**: 10 % → 12 % normal y 0 % → 4 % con lluvia (la primera
  vez que la red termina vueltas mojadas). Sus accidentes: 29 salidas de pista, 26 vallas y 6 trompos
  por cada 30 pistas (media de semillas).
* **Q-learning bajó** (6 % → 2 %): la tabla no ve el peso ni la suspensión (sigue con 720 estados),
  así que la física nueva la afecta sin darle información nueva.
* Las ruedas casi nunca se levantan (0,1 % del tiempo): las reglas y PPO no llegan a ese límite.
* Modelo recomendado: **PPO semilla 7** (el mejor en validación; también el mejor en el examen, 17 %).

### Qué aprendimos y qué sigue

Darle al agente más sensores de su propio coche (peso, suspensión) ayudó poco: el problema de PPO
no es "sentir" el coche sino **ver la pista que viene**. Hoy solo ve 6 celdas de 10 m adelante y
la curvatura a 30 y 60 m. Eso es exactamente el N7: sensores tipo Gran Turismo Sophy (curvatura y
ancho de la pista adelante según la velocidad) y una recompensa revisada. Y en el N8 aprenderá
primero imitando a las reglas, que hoy completan el 87 %.

Paquetes publicados en la web: `modelos/n6/ppo-recomendado/` (model.zip, policy.onnx,
normalization.json, manifest.json) y `modelos/n6/qlearning-mejor/` (q_table.npy).

## 8. Cómo ejecutarlo

```powershell
.venv\Scripts\python.exe -m unittest tests.test_rally_v6
$env:PYTHONUTF8="1"; $env:PREFECT_SERVER_EPHEMERAL_ENABLED="true"; $env:DVC_NO_ANALYTICS="1"
.venv\Scripts\python.exe run_experiment.py --environment-version rally-v6
```

Prueba rápida sin DVC ni MLflow: `python pipeline_v6.py --timesteps 20000 --seeds 7 --skip-tracking`.

## 9. Límites

* La suspensión es de "carrocería entera" (cabeceo, balanceo y altura), no cuatro resortes
  independientes: una rueda no puede pisar un bache sola.
* No hay marcha atrás (eso es el N9).
* La aerodinámica no cambia con la altura del coche.
