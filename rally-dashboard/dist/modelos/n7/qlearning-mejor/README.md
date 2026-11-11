---
tags:
- reinforcement-learning
- qlearning
- gymnasium
---

# Autonomous Rally N7 · Q-learning tabular discretizado (720×15)

Semilla 42, 1000103 pasos de entrenamiento. Evaluación en la suite `rally-v7-suite-1` (30 pistas nunca vistas): éxito 7%.

Cargar con `numpy.load('q_table.npy')`; ver `contract.discretization` en manifest.json.

Contrato completo de entrada y salida en `manifest.json`.
