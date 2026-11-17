# Manifiesto de modelos, evaluación y recuperación

Cada modelo publicado es una carpeta en `rally-dashboard/dist/modelos/<nivel>/` (también servida en
https://autonomous-rally-lake.vercel.app/modelos/…) con:

| Archivo | Qué es |
|---|---|
| `manifest.json` | run, nivel, versión de ambiente, algoritmo, semilla, commit de origen, SHA-256 de la configuración, del modelo y de cada archivo, presupuesto, punto elegido, parada temprana, episodios |
| `model.zip` | pesos (Stable-Baselines3) |
| `normalization.json` | media y varianza de la observación (obligatoria para usar el modelo) |
| `policy.onnx` | la red exportada a ONNX, verificada contra PyTorch |
| `config.json` | configuración completa con la que se entrenó (ambiente compatible) |
| `evaluation.json` | evaluación por caso en las 30 pistas (normal, lluvia, sensor con ruido); copia en CSV por run en `reports/casos/` |
| `training_curves.json` | curvas de entrenamiento |
| `README.md` | ficha del modelo |

Dependencias: `requirements.txt` (gymnasium, stable-baselines3, onnx, onnxruntime…) + PyTorch CPU 2.9.1.

## Modelo recomendado

| | |
|---|---|
| Ruta | `rally-dashboard/dist/modelos/n8/ppo-recomendado/` |
| Run | `rally-v8-ppo-4af197cc74ad4f74baddb6020d2eaaa7` (N8, intento 2, semilla 42) |
| Ambiente compatible | `rally-v8` (`race_env_v8.py` = física de `race_env_v7.py`) |
| Commit de origen | `e536563a…` (ver `git_commit` en el manifiesto) |
| SHA-256 de `model.zip` | `f385c140a46c92274714f4d6bf7ec50d9f3f15494df913896fd5a57120d41d06` |
| Examen | 83 % vueltas completas, 70 % limpias, 69,8 s por vuelta (media de las 3 semillas del N8: 83 %, 70 %, 68,5 s) |

## Modelo histórico (para rollback)

| | |
|---|---|
| Ruta | `rally-dashboard/dist/modelos/n7/ppo-recomendado/` |
| Run | `rally-v7-ppo-d268569f2d3a497288140a7a1ddaa9cb` (N7, intento 3, semilla 42) |
| Ambiente compatible | `rally-v7` (`race_env_v7.py`, etiqueta `rally-v7-n7-maestro`) |
| Examen | 73 % vueltas completas, 69,0 s por vuelta (media de las 3 semillas del N7: 80 %) |

Otros publicados: `n4`, `n5`, `n6` (PPO recomendado y mejor Q-learning de cada nivel), cada uno con su manifiesto.
El N2 está en Hugging Face (`MAT7IAS24/autonomous-rally-q-learning`); N1 y N3 como artefactos de MLflow.

## Cómo evaluar y recuperar un modelo

```bash
pip install -r requirements.txt
pip install torch==2.9.1 --index-url https://download.pytorch.org/whl/cpu

# Recuperar el recomendado: verifica hashes y repite su examen pista por pista
python recuperar_modelo.py rally-dashboard/dist/modelos/n8/ppo-recomendado --pistas 5

# Rollback: recuperar el modelo histórico del N7 con su ambiente compatible
python recuperar_modelo.py rally-dashboard/dist/modelos/n7/ppo-recomendado --pistas 5

# Prueba automática de recuperación y rollback
python -m unittest tests.test_recuperacion
```

Salida esperada: todos los hashes `OK`, cada pista `OK` y `RECUPERADO · idéntico a la versión entregada`.

Para volver al código exacto de una versión: `git checkout <etiqueta>` (ver `docs/comparacion-experimentos.md`).
Para repetir el examen completo de un nivel: `python pipeline_v8.py --skip-tracking` (o `pipeline_v7.py`, …).

## Rollback ejecutado en el proyecto

El N8 intento 3 (choques más caros y volante suave) empeoró las vueltas limpias (70 % → 68 %). Se aplicó la
regla fijada antes de entrenar: no se promovió, y la versión servida (web, `v8-results.json`, modelo
recomendado) volvió al intento 2. El intento 3 queda guardado con su etiqueta `rally-v8-n8-intento3` y su
informe. La prueba `tests/test_recuperacion.py` comprueba que un modelo anterior se recupera idéntico.
