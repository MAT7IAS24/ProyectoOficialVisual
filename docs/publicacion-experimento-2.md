# Publicación del experimento 2

Versión: `rally-v2-n2`. Ambiente `rally-v2`, recompensa `v2`.

El código usado en las tres corridas corresponde al commit
`ef4926ca298da7f509fea8b6182879050b10be4e`. El manifiesto
[`rally-v2-7ab407ddd3f64be3921db0b3f878004e-publication.json`](../reports/rally-v2-7ab407ddd3f64be3921db0b3f878004e-publication.json)
relaciona cada semilla con su corrida MLflow, puntero DVC, hashes SHA-256 y
revisión inmutable de Hugging Face. Los archivos descargados de cada revisión
de Hugging Face se verificaron contra los originales locales.

Se conservan tres modelos independientes: semillas 7, 21 y 42, con 3000
episodios de entrenamiento cada uno. Cada modelo completó las 30 evaluaciones:
retorno medio 36.4, 7 pasos, combustible restante 56 y ninguna salida de pista.
La varianza entre semillas de estas métricas de evaluación fue cero.

## Dónde se conserva cada componente

- **Código, configuración, interfaz y pipeline Prefect:** rama
  `experiment/rally-v2`, etiqueta `rally-v2-n2` en GitHub.
- **Datos:** tres CSV identificados por sus archivos `transitions.csv.dvc`,
  incluidos en Git. Los contenidos están en la caché DVC local. No hay remoto
  DVC configurado: clonar GitHub por sí solo no recupera esos CSV.
- **Experimentos:** tres corridas terminadas en MLflow, con métricas,
  artefactos y referencias de publicación. La base `mlflow.db` y `mlruns/`
  son locales; no existe un servidor MLflow compartido configurado.
- **Orquestación:** `pipeline_v2.py` versionado, ejecución Prefect local.
- **Modelos:** repositorio privado
  [MAT7IAS24/autonomous-rally-q-learning](https://huggingface.co/MAT7IAS24/autonomous-rally-q-learning),
  cada corrida en `runs/<experiment_id>` con tabla Q, configuración,
  evaluación, métricas y metadatos. Las revisiones exactas están en el manifiesto.

El experimento 1 conserva sus archivos, datos y modelo, y sigue seleccionable.
Esta publicación no fusiona las ramas ni sustituye los artefactos anteriores.

## Consultar y reproducir

```bash
git checkout rally-v2-n2
.venv/bin/python -m dvc status
.venv/bin/mlflow ui --backend-store-uri sqlite:///mlflow.db --port 5000
```

Para producir nuevas corridas (con identificadores nuevos), seguir los comandos
de [rally-v2.md](rally-v2.md). Conservar la caché DVC y el almacenamiento MLflow
local hasta configurar y verificar una copia remota.
