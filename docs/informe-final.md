# Informe final · Autonomous Rally

**Equipo:** David Tinjacá, Mattias Morales y David Briñez · MLOps, Visualización 2, Grupo B ·
Universidad Externado de Colombia · Docente: Julián Zuluaga.

## Resumen

Construimos un agente que aprende a completar una vuelta de rally en pistas que nunca vio, y lo hicimos crecer en
8 experimentos versionados. El resultado oficial (N8) termina el 83 % de las vueltas en 68,5 s, más rápido que el
maestro (reglas: 87 %, 70,3 s), pero con menos vueltas sin choques (70 % contra 83 %). En total: 64 modelos,
≈ 259 mil episodios y 54,6 millones de pasos.

## Decisiones

| Decisión | Por qué |
|---|---|
| Empezar con Q-learning en tabla (N1–N3) | El método más simple y explicable para montar el ciclo de MLOps completo |
| Pasar a física continua y PPO (N4) | La tabla no generaliza a pistas nuevas (N3: se congeló con lluvia). PPO maneja acciones continuas y es el de referencia de la guía |
| Agregar realismo de a un cambio (N5 llantas, N6 peso) | Para saber qué causa cada efecto; cada cambio con su hipótesis y pruebas de banco |
| Suite fija de 30 pistas + 3 semillas | Comparar todo en las mismas condiciones y descartar suerte |
| Elegir el mejor punto por validación (desde N5) | El último punto del entrenamiento no siempre es el mejor; la validación usa otras pistas, no las del examen |
| Imitar al maestro con DAgger antes de PPO (N7) | Aprendiendo solo, PPO casi nunca llegaba a la meta y no veía el premio |
| Parada temprana, corte de episodios y libro de episodios (N8) | Entrenar más sin gastar pasos en vano y contar cada episodio |
| Rechazar y guardar los intentos que no cumplen | La hipótesis se fija antes de entrenar; lo que no mejora se documenta igual |
| Rollback del N8 intento 3 al intento 2 | El intento 3 empeoró las vueltas limpias; se sirvió de nuevo la versión anterior |

## Resultados

Detalle por experimento: `docs/comparacion-experimentos.md`. Lo central:

- **Tabla vs red:** en pistas nuevas con física (N4), PPO 20 % contra Q-learning 6 %.
- **Aprender solo no alcanza:** PPO 10–20 % del N4 al N6, reglas 87 %.
- **Aprender de un maestro funciona:** N7, de 9 % a 80 % con la mitad de los pasos.
- **Entrenar más mejora el tiempo, la lluvia y los choques:** N8, 83 % completas, 68,5 s, lluvia 83 %, 0,80 choques por vuelta.
- **Incidente de degradación (N3):** con lluvia el modelo cayó de 100 % a 0 %. Intervención A (reentrenar solo con
  lluvia) recuperó la lluvia pero olvidó la pista normal: rechazada. Intervención B (clima mixto) recuperó ambas:
  aceptada (`docs/rally-v3.md`, sección 8). Desde el N4 cada examen incluye lluvia y sensores con ruido.
- **Rollback:** ver `docs/modelos.md`; `tests/test_recuperacion.py` recupera el modelo recomendado y el histórico
  con hashes válidos y el mismo resultado pista por pista.

## Límites

- El agente choca más que el maestro: 70 % de vueltas limpias contra 83 %, igual en 3 intentos.
- Con sensores con ruido baja a 57 % de vueltas completas.
- MLflow y la caché de DVC viven en el computador de un integrante: el registro completo de runs no está en línea.
  Los informes JSON (`reports/`), la evaluación por caso (`reports/casos/`), los paquetes de modelo y la web
  reemplazan esa consulta.
- La web reproduce carreras calculadas por Python; no corre el modelo en vivo en el navegador.
- Del N4 al N7 los episodios son estimados (solo se guardaron los pasos); desde el N8 se cuentan uno a uno.
- Los ambientes son una simulación simplificada, no un vehículo real.

## Contribuciones

El proyecto fue un trabajo conjunto de los tres integrantes en cada experimento: diseño del ambiente y de las
hipótesis, entrenamiento, revisión de resultados, versionado, la web y la presentación se decidieron y revisaron
en equipo.

| Integrante | Participación |
|---|---|
| David Tinjacá | Trabajo conjunto en todos los experimentos (N1–N8); en la presentación: problema, misión y ambiente |
| Mattias Morales | Trabajo conjunto en todos los experimentos (N1–N8); dueño del repositorio; en la presentación: recompensas, modelo y experimentación |
| David Briñez | Trabajo conjunto en todos los experimentos (N1–N8); en la presentación: N8, episodios, versionamiento, demo y conclusiones |

## Siguiente paso

Cambiar el método, no solo el tiempo de entrenamiento: mezclar imitación y práctica, dar al agente información
sobre lo que causa cada choque, y montar un registro compartido (DagsHub) para MLflow y DVC.
