---
tags:
- reinforcement-learning
- ppo
- gymnasium
---

# Autonomous Rally N7 · PPO (Stable-Baselines3, red 256×256, primero imita a las reglas con DAgger y después afina con PPO)

Semilla 42, 401408 pasos de entrenamiento. Evaluación en la suite `rally-v7-suite-1` (30 pistas nunca vistas): éxito 73%.

Cargar: `PPO.load('model.zip')` + `VecNormalize.load('vecnormalize.pkl', venv)`; o en el navegador `policy.onnx` (ya incluye la normalización: entra la observación cruda de 250 números, sale [acelerador, giro]).

Contrato completo de entrada y salida en `manifest.json`.
