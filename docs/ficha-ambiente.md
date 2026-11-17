# Ficha del ambiente · Autonomous Rally

**Misión.** Un vehículo autónomo debe completar una vuelta de 1,1 km en una pista que cambia en cada
carrera (barro, agua, pasto, fosos, rampas, vallas y lluvia), lo más rápido posible y sin chocar ni
quedarse atascado. Contexto de negocio: vehículos autónomos de rally, inspección o logística rural que
recorren rutas variables; un error cuesta daño y tiempo, y no es viable escribir una regla para cada terreno.

**Métricas de la misión** (siempre en las mismas 30 pistas de examen, semillas 100000–100029, nunca usadas
para entrenar): vueltas completas, vueltas limpias (0 choques) y tiempo de vuelta.

## Los tres niveles del ambiente

| Nivel | Experimentos | Ambiente | Versión (`environment_version`) | Agente |
|---|---|---|---|---|
| 1 · Tabular | N1, N2, N3 | Pista por tramos: 1 km (N1–N2), 3 km con 4 carriles, rampas y puente (N3); acciones discretas | `race_env` (N1), `rally-v2`, `rally-v3` | Q-learning en tabla |
| 2 · Física continua | N4, N5, N6 | Óvalo de 1,1 km generado al azar, física en m/s, llantas Pacejka (N5), peso y suspensión (N6) | `rally-v4`, `rally-v5`, `rally-v6` | PPO 64×64 vs Q-learning discretizado |
| 3 · Piloto con maestro | N7, N8 | Física del N6 + “mirada de piloto” (250 sensores) | `rally-v7`, `rally-v8` (misma física; la v8 solo cambia 3 números de la recompensa) | Imitación DAgger + PPO 256×256 |

Código de cada ambiente: `race_env.py`, `race_env_v2.py` … `race_env_v8.py`. Configuración: `configs/rally-v*.json`.

## Ambiente actual (rally-v8)

**Observación**: vector de 250 valores (`gymnasium.spaces.Box(-5, 5, (250,))` tras normalizar):
| Grupo | Variables | Rango / unidad |
|---|---|---|
| Coche | velocidad hacia adelante y lateral, giro, deslizamiento | 0–35 m/s, rad/s, grados |
| Piso | agarre, terreno bajo el coche | 0–1, categoría |
| Peso | peso adelante y afuera, cabeceo, balanceo, compresión de suspensión | fracción, grados, m |
| Mandos reales | volante y pedal aplicados | −1 a 1 |
| Mirada de piloto | 8 puntos de la línea central a 0,5 / 1 / 1,5 / 2 / 2,5 / 3 / 4 / 5 s adelante (distancia, lado, curvatura) | m, rad/m |
| Obstáculos | 10 celdas adelante × 4 carriles × 5 rasgos (peligro, rampa, frena, agarre, puente), hasta 100 m | 0–1 |

La normalización (media y varianza) se guarda con cada modelo en `normalization.json`.

**Acción**: `Box(-1, 1, (2,))`. Pedal: −1 frena a fondo (hasta 9 m/s²), +1 acelera a fondo (hasta 6 m/s²).
Volante: −1 a 1 (+ = izquierda). El coche los aplica gradualmente.

**Paso**: una decisión cada 0,25 s; la física avanza 10 subpasos de 0,025 s. Masa 1.250 kg, velocidad máxima 35 m/s.

**Episodio** (una carrera):
| Condición | Cuándo | Tipo |
|---|---|---|
| Éxito | cruza la meta (1,1 km) | `terminated`, causa `vuelta_completada` |
| Fallo | 5 accidentes, o atascado 40 pasos (10 s) | `terminated`, causa `demasiados_accidentes` / `atascado` |
| Truncamiento | 600 pasos (150 s) | `truncated`, causa `limite_pasos` |
| Corte de entrenamiento (solo N8 al entrenar) | 400 pasos | `truncated`, causa `corte_de_entrenamiento` |

**Recompensa v8** (resultado oficial del N8): +0,05 por metro, +0,5 por checkpoint (cada 50 m), +30 al llegar,
−0,1 por paso, −10 por accidente, −10 por quedar atascado. Verificación de que representa la misión: el retorno
medio ordena a los agentes igual que las vueltas completas (azar −29,4 / 0 %; PPO N7 37,3 / 70 %; PPO N8 51,6 /
83 %; reglas 54,4 / 87 %; informe `reports/rally-v8-74e763f3….json`). Además el mejor modelo se elige por las
métricas de la misión, no por la recompensa.

**Perturbaciones del examen**: `lluvia` (menos agarre, charcos) y `sensor_ruidoso` (ruido en la observación).
