# Experimento 8 · rally-v8 (nivel N8) · "Superar al maestro"

**En pocas palabras.** En el N7 el alumno (PPO) aprendió copiando a las reglas y llegó a 80 % de vueltas, pero no
superó al maestro. En el N8 no se toca el coche, la pista, los 250 sensores ni las 30 pistas del examen: cambia
**cómo se entrena**. La hipótesis se escribió antes de entrenar.

## Qué cambió frente al N7

1. **Parada temprana** en la imitación (14 rondas como máximo; para si pasan 4 sin mejorar) y en PPO (para si pasan
   8–10 exámenes de validación seguidos sin mejorar, después de un mínimo de pasos).
2. **Mucho más entrenamiento**: hasta 2 millones de pasos de PPO por modelo en el intento 1 y 3 millones más en el
   intento 2 (N7: 400 mil).
3. **Practica con lluvia y con sensores con ruido**: 8 coches a la vez, 4 normales, 2 con lluvia y 2 con ruido.
4. **Corte de episodios** en el entrenamiento a los 400 pasos (100 s); el examen no se corta.
5. **Libro de episodios**: cada carrera de entrenamiento se cuenta, con su fase (imitación o práctica) y cómo terminó.
6. **Recompensa v8**: cada paso cuesta 0,1 (antes 0,02) y cada accidente 10 (antes 5), para premiar la vuelta rápida y limpia.
7. **Mejor punto**: se elige primero por vueltas limpias (sin ningún choque), luego completas, luego tiempo.

Un **episodio** es una carrera completa: termina al llegar a la meta, con 5 accidentes, atascado 10 s o al cortarse.
Un **paso** es una decisión de la IA (cada 0,25 s de carrera).

## Hipótesis y resultado (30 pistas de examen, media de 3 semillas)

| Criterio | Meta | Maestro | N7 | Intento 1 | **Intento 2** | ¿Cumple? |
|---|---|---|---|---|---|---|
| Vueltas limpias · PPO | ≥ 84 % | 83 % | 63 % | 70 % | **70 %** | No |
| Tiempo de vuelta · PPO | ≤ 70,3 s | 70,3 s | 70,2 s | 68,5 s | **68,5 s** | Sí |
| Vueltas con lluvia · PPO | ≥ 70 % | 87 % | 58 % | 82 % | **83 %** | Sí |

Otros: vueltas completas 83 % (intento 1: 79 %; N7: 80 %), choques por vuelta 0,80 (intento 1: 1,03; N7: 1,28;
maestro: 0,70), sensores con ruido 57 %.

**Veredicto: NO CONFIRMADA (2 de 3).** Informes: `reports/rally-v8-a5d037b4…json` (intento 1) y
`reports/rally-v8-74e763f3…json` (intento 2).

## Intentos

* **Intento 1** (etiqueta `rally-v8-n8-intento1`): imitación con parada temprana + PPO hasta 2 M de pasos, validación
  en 30 pistas. 20.795 episodios, 5,7 M de pasos. Dos de tres modelos pararon solos.
* **Intento 2** (etiqueta `rally-v8-n8`): cada modelo continúa desde su mejor punto del intento 1, sin repetir la
  imitación; validación en 60 pistas (menos ruido), paciencia 10, tasa 5e-5. 20.550 episodios más; los tres modelos
  pararon solos (ahorró 3,3 M de pasos). Modelo recomendado: semilla 42.

Total del experimento: **41.345 episodios y 11,4 millones de pasos**, 6 modelos.

* **Intento 3** (etiqueta `rally-v8-n8-intento3`, informe `reports/rally-v8-5b00709a…json`): continúa desde el intento 2
  con dos cambios solo en el entrenamiento: cada accidente cuesta 25 (antes 10) y se cobra 0,3 × el cambio del volante
  entre decisiones, para que maneje suave (el coche se veía temblar por el volante en zigzag). Resultado: 68 % limpias,
  83 % completas, 68,5 s, 0,78 choques, lluvia 82 %; zigzag del volante 0,47. Dos de tres modelos no encontraron un
  punto mejor que el de partida y el tercero empeoró un poco. **No mejoró: el resultado oficial del N8 sigue siendo
  el intento 2.** 12.513 episodios más.

Total del experimento con los tres intentos: **53.858 episodios y 14,9 millones de pasos**, 9 modelos.

## Lectura honesta

Practicar más bajó el tiempo de vuelta, los choques y mejoró mucho la lluvia, pero las vueltas sin ningún choque se
quedaron en 70 % en las tres semillas y en los tres intentos. Ni más práctica ni castigar más los choques las sube. Para el
N9 hay que cambiar el método (por ejemplo, castigar más los roces leves o mezclar imitación y práctica), no solo el tiempo.

## Página web (`v8.html`)

Pantalla completa (botón, tecla F o doble clic), pista a todo el ancho con la telemetría encima, cuatro pestañas
(Resumen, Entrenamiento y episodios, Modelos y versiones, Qué es cada cosa), calle de pits con coches, paddock y lago en
el centro del óvalo, modo día, atardecer y noche (`v8.html?hora=noche`), y calidad automática que baja la resolución
cuando el computador no da. El catálogo (`catalogo.json`, generado por `build_catalog.py`) cuenta modelos, episodios y
pasos de los ocho experimentos.

Datos generados con `--skip-tracking`: falta repetir la corrida oficial con DVC y MLflow.
