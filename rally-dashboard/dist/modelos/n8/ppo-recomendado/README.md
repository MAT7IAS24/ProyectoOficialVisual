---
tags:
- reinforcement-learning
- ppo
- imitation-learning
- gymnasium
---

# Autonomous Rally N8 · PPO (Stable-Baselines3, red 256×256)

Semilla 21. Primero imita a las reglas (DAgger) y después practica con PPO, con parada temprana.

- Entrenamiento: 7934 episodios, 2195303 pasos (imitación + práctica).
- Examen en la suite `rally-v7-suite-1` (30 pistas nunca vistas): vueltas completas 87%, vueltas limpias 73%, vuelta media 67.7 s.

Cargar: `PPO.load('model.zip')` y normalizar la observación con `normalization.json`; o en el navegador `policy.onnx` (ya incluye la normalización: entra la observación cruda de 250 números, sale [acelerador, giro]).

Contrato completo de entrada y salida, libro de episodios y parada temprana en `manifest.json`.
