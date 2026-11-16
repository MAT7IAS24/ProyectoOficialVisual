---
tags:
- reinforcement-learning
- ppo
- imitation-learning
- gymnasium
---

# Autonomous Rally N8 · PPO (Stable-Baselines3, red 256×256)

Semilla 42. Primero imita a las reglas (DAgger) y después practica con PPO, con parada temprana.

- Entrenamiento: 8936 episodios, 2498980 pasos (imitación + práctica).
- Examen en la suite `rally-v7-suite-1` (30 pistas nunca vistas): vueltas completas 83%, vueltas limpias 70%, vuelta media 69.8 s.

Cargar: `PPO.load('model.zip')` y normalizar la observación con `normalization.json`; o en el navegador `policy.onnx` (ya incluye la normalización: entra la observación cruda de 250 números, sale [acelerador, giro]).

Contrato completo de entrada y salida, libro de episodios y parada temprana en `manifest.json`.
