# Comparación de experimentos

Cada fila es una configuración con hipótesis escrita **antes** de entrenar (`configs/rally-v*.json`, clave
`experiment.hypothesis`), su informe con los runs y el estado. Desde el N4: mismas 30 pistas de examen y 3
semillas (7, 21, 42). Baseline: reglas a mano y Q-learning (y política aleatoria).

| Nivel | Etiqueta | Hipótesis (resumen) | Resultado en examen | Estado | Informe |
|---|---|---|---|---|---|
| N1 | `rally-v1-n1` | Montar el ciclo MLOps en 1 km | 100 %, 10 pasos | Aceptado | MLflow (corrida única) |
| N2 | `rally-v2-n2` | Curvas y combustible, 3 semillas | 100 %, retorno +36,4 | Aceptado | `reports/rally-v2-7ab407dd….json` |
| N3 | `rally-v3-n3` | ≥ 90 % y +30 puntos sobre reglas; incidente de lluvia | Q 100 % vs reglas 53 %; lluvia 0 % → intervención B 100 % | Aceptado | `reports/rally-v3-50a0e59b….json` |
| N4 | `rally-v4-n4` | PPO ≥ 70 % en pistas nuevas y +30 sobre Q-learning | PPO 20 %, Q 6 %, reglas 87 % | Rechazado | `reports/rally-v4-fdd4946a….json` |
| N5 · intento 1 | (en `rally-v5-n5`) | Barro < 3°, reglas ≥ 80 %, PPO ≥ 15 % | PPO 0 % | Rechazado | `reports/rally-v5-132e21c5….json` |
| N5 · intento 2 | `rally-v5-n5` | Igual, con mejor punto por validación | Barro 2,7°, reglas 87 %, PPO 10 % | Rechazado | `reports/rally-v5-e7e8a036….json` |
| N6 | `rally-v6-n6` | Banco realista, reglas ≥ 80 %, PPO ≥ 15 % | Cabeceo 2,1°, balanceo 3,5°, reglas 87 %, PPO 12 % | Rechazado (3 de 4) | `reports/rally-v6-fa67dfc2….json` |
| N7 · intento 1 | (en `rally-v7-n7`) | Mirada de piloto + recompensa v7: PPO ≥ 25 % | PPO 2 % | Rechazado | `reports/rally-v7-b8fac7f9….json` |
| N7 · intento 2 | `rally-v7-n7` | Mirada de piloto con recompensa v5 | PPO 9 %, 1,61 choques | Rechazado | `reports/rally-v7-cbe88188….json` |
| N7 · intento 3 | `rally-v7-n7-maestro` | Imitar al maestro + PPO: ≥ 70 %, < 2,29 choques, reglas ≥ 80 % | PPO 80 %, 1,28 choques, lluvia 58 % | **Aceptado** | `reports/rally-v7-e0b9ad00….json` |
| N8 · intento 1 | `rally-v8-n8-intento1` | Limpias ≥ 84 %, vuelta ≤ 70,3 s, lluvia ≥ 70 % | 70 % limpias, 79 % completas, 68,5 s, lluvia 82 % | Rechazado (2 de 3) | `reports/rally-v8-a5d037b4….json` |
| N8 · intento 2 | `rally-v8-n8` | Igual, continuando desde el mejor punto | 70 % limpias, **83 %** completas, 68,5 s, lluvia 83 %, 0,80 choques | Rechazado (2 de 3) · **resultado oficial del N8** | `reports/rally-v8-74e763f3….json` |
| N8 · intento 3 | `rally-v8-n8-intento3` | Igual + choques más caros y volante suave | 68 % limpias, 83 % completas | Rechazado · **rollback al intento 2** | `reports/rally-v8-5b00709a….json` |

**Qué mejoró:** pasar de tabla a red neuronal generaliza mejor (N4: PPO 20 % vs Q 6 %); imitar al maestro llevó
a PPO de 9 % a 80 % (N7); entrenar más con parada temprana subió las vueltas completas a 83 %, bajó el tiempo
a 68,5 s y los choques a 0,80 (N8).
**Qué empeoró o no mejoró:** N5 intento 1 (0 %), N7 intentos 1 y 2 (2 % y 9 %), N8 intento 3 (68 % limpias).
Todos quedan versionados con su informe.

Cada informe trae: configuración completa, runs por semilla (id, MLflow run, puntero DVC), resumen de la evaluación,
referencias y decisión. La **evaluación por caso** (cada pista: éxito, retorno, pasos, tiempo, choques, causa de
terminación) está en `reports/casos/<run>.csv` para los modelos publicados del N4 al N8 y los runs del N7 (intento 3) y del N8,
y dentro de cada paquete (`evaluation.json`); la de runs anteriores está como artefacto en MLflow.
