---
tags:
- reinforcement-learning
- ppo
- gymnasium
---

# Autonomous Rally N4 · PPO (Stable-Baselines3, red 64×64)

Semilla 7, 1001472 pasos de entrenamiento. Evaluación en la suite `rally-v4-suite-1` (30 pistas nunca vistas): éxito 27%.

Cargar: `PPO.load('model.zip')` + `VecNormalize.load('vecnormalize.pkl', venv)`; o en el navegador `policy.onnx` (ya incluye la normalización: entra la observación cruda de 134 números, sale [acelerador, giro]).

Contrato completo de entrada y salida en `manifest.json`.
