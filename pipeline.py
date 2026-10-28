"""Reproduce el experimento de train.py y versiona sus artefactos.

El primer experimento interactivo no guardaba datos; cada ejecución de este
pipeline crea una nueva corrida, sin atribuirle resultados históricos.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import random
import subprocess
import sys
import uuid
from pathlib import Path

import mlflow
import numpy as np
from prefect import flow, task

from race_env import OneKilometerRaceEnv

ROOT = Path(__file__).resolve().parent
ALPHA, GAMMA = 0.25, 0.95


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@task(name="entrenar-y-generar-datos")
def train_experiment(experiment_id: str, episodes: int, seed: int) -> dict:
    rng = random.Random(seed)
    env = OneKilometerRaceEnv()
    q_table = np.zeros((env.observation_space.n, env.action_space.n), dtype=float)
    dataset = ROOT / "data" / "experiments" / experiment_id / "transitions.csv"
    model_dir = ROOT / "models" / experiment_id
    dataset.parent.mkdir(parents=True, exist_ok=False)
    model_dir.mkdir(parents=True, exist_ok=False)
    episode_metrics = []
    fields = ["episode", "step", "state", "action", "next_state", "reward", "terminated", "truncated", "position_meters", "epsilon", "q_before", "q_after", "episode_return"]
    with dataset.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=fields)
        writer.writeheader()
        for episode in range(1, episodes + 1):
            state, info = env.reset(seed=seed + episode)
            epsilon = max(0.05, 1.0 - (episode - 1) / max(1, episodes - 1) * 0.95)
            episode_return = 0.0
            while True:
                action = rng.randrange(2) if rng.random() < epsilon else int(np.argmax(q_table[state]))
                next_state, reward, terminated, truncated, info = env.step(action)
                episode_return += reward
                q_before = float(q_table[state, action])
                target = reward if terminated or truncated else reward + GAMMA * np.max(q_table[next_state])
                q_table[state, action] += ALPHA * (target - q_table[state, action])
                writer.writerow({"episode": episode, "step": info["steps"], "state": state, "action": action, "next_state": next_state, "reward": reward, "terminated": terminated, "truncated": truncated, "position_meters": info["position_meters"], "epsilon": epsilon, "q_before": q_before, "q_after": float(q_table[state, action]), "episode_return": episode_return})
                state = next_state
                if terminated or truncated:
                    episode_metrics.append({"episode": episode, "return": episode_return, "steps": info["steps"], "success": int(terminated), "truncated": int(truncated), "epsilon": epsilon})
                    break
    env.close()
    model = model_dir / "q_table.npy"
    np.save(model, q_table, allow_pickle=False)
    evaluation = evaluate_policy(q_table, seed)
    metadata = {
        "experiment_id": experiment_id, "kind": "new_reproducible_run", "algorithm": "tabular_q_learning",
        "episodes": episodes, "seed": seed, "alpha": ALPHA, "gamma": GAMMA,
        "track_length_m": 1000, "step_size_m": 100, "max_steps": 50,
        "actions": {"0": "reversa", "1": "acelerar"}, "state": "tramo de 100 m, entre 0 y 10",
        "dataset_sha256": sha256(dataset), "model_sha256": sha256(model),
        "evaluation": evaluation,
        "source_sha256": {name: sha256(ROOT / name) for name in ("pipeline.py", "race_env.py", "train.py")},
    }
    (model_dir / "metadata.json").write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (model_dir / "README.md").write_text("---\ntags:\n- reinforcement-learning\n- q-learning\n- gymnasium\n---\n\n# Autonomous Rally: tabla Q\n\nTabla Q NumPy `(11, 2)` de un agente tabular. Las columnas representan reversa y acelerar; las filas representan tramos de 100 m. Esta es una nueva corrida reproducible, no el resultado histórico del primer experimento interactivo.\n\nCarga con `numpy.load('q_table.npy', allow_pickle=False)` y selecciona una acción con `numpy.argmax(q[state])`. Consulta `metadata.json` para la semilla, parámetros, huellas y evaluación.\n", encoding="utf-8")
    return {"experiment_id": experiment_id, "dataset": str(dataset), "model_dir": str(model_dir), "episodes": episode_metrics, "metadata": metadata}


def evaluate_policy(q_table: np.ndarray, seed: int, episodes: int = 5) -> dict:
    env = OneKilometerRaceEnv()
    successes, returns, lengths = 0, [], []
    for episode in range(episodes):
        state, info = env.reset(seed=seed + 10000 + episode)
        total = 0.0
        while True:
            state, reward, terminated, truncated, info = env.step(int(np.argmax(q_table[state])))
            total += reward
            if terminated or truncated:
                successes += int(terminated)
                returns.append(total)
                lengths.append(info["steps"])
                break
    env.close()
    return {"episodes": episodes, "success_rate": successes / episodes, "mean_return": float(np.mean(returns)), "mean_steps": float(np.mean(lengths)), "policy": "greedy_sin_exploracion"}


@task(name="versionar-dataset-con-dvc")
def version_dataset(result: dict) -> dict:
    dataset = Path(result["dataset"])
    subprocess.run([sys.executable, "-m", "dvc", "add", str(dataset.relative_to(ROOT))], cwd=ROOT, check=True)
    pointer = dataset.with_suffix(dataset.suffix + ".dvc")
    result["dvc_pointer"] = str(pointer.relative_to(ROOT))
    result["dvc_pointer_sha256"] = sha256(pointer)
    return result


@task(name="registrar-experimento-en-mlflow")
def register_mlflow(result: dict) -> dict:
    tracking_uri = os.environ.get("MLFLOW_TRACKING_URI", f"sqlite:///{ROOT / 'mlflow.db'}")
    mlflow.set_tracking_uri(tracking_uri)
    experiment = mlflow.get_experiment_by_name("autonomous-rally")
    if experiment is None:
        artifact_location = (ROOT / "mlruns" / "artifacts").as_uri() if tracking_uri.startswith("sqlite:") else None
        mlflow.create_experiment("autonomous-rally", artifact_location=artifact_location)
    mlflow.set_experiment("autonomous-rally")
    metadata = result["metadata"]
    with mlflow.start_run(run_name=result["experiment_id"]) as run:
        mlflow.log_params({key: metadata[key] for key in ("episodes", "seed", "alpha", "gamma", "max_steps", "step_size_m", "track_length_m")})
        mlflow.set_tags({"data.kind": "new_reproducible_run", "data.sha256": metadata["dataset_sha256"], "data.dvc_pointer": result["dvc_pointer"], "data.dvc_pointer_sha256": result["dvc_pointer_sha256"], "model.sha256": metadata["model_sha256"], "algorithm": metadata["algorithm"]})
        for item in result["episodes"]:
            mlflow.log_metrics({"episode_return": item["return"], "episode_steps": item["steps"], "episode_success": item["success"], "episode_truncated": item["truncated"], "epsilon": item["epsilon"]}, step=item["episode"])
        evaluation = metadata["evaluation"]
        mlflow.log_metrics({"training_success_rate": sum(e["success"] for e in result["episodes"]) / len(result["episodes"]), "evaluation_success_rate": evaluation["success_rate"], "evaluation_mean_return": evaluation["mean_return"], "evaluation_mean_steps": evaluation["mean_steps"]})
        mlflow.log_artifacts(result["model_dir"], artifact_path="model")
        mlflow.log_artifact(result["dataset"], artifact_path="dataset")
        mlflow.log_artifact(str(ROOT / result["dvc_pointer"]), artifact_path="dataset")
        result["mlflow_run_id"] = run.info.run_id
        result["mlflow_tracking_uri"] = tracking_uri
    return result


@flow(name="autonomous-rally-experimento", log_prints=True)
def rally_pipeline(episodes: int = 25, seed: int = 7) -> dict:
    if episodes < 1:
        raise ValueError("episodes debe ser >= 1")
    experiment_id = uuid.uuid4().hex
    result = train_experiment(experiment_id, episodes, seed)
    result = version_dataset(result)
    result = register_mlflow(result)
    print(f"Corrida: {experiment_id} | MLflow: {result['mlflow_run_id']}")
    print(f"DVC: {result['dvc_pointer']} | Modelo: {result['model_dir']}")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Pipeline reproducible de Autonomous Rally")
    parser.add_argument("--episodes", type=int, default=25)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    rally_pipeline(args.episodes, args.seed)
