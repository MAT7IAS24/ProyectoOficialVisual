"""Prefect + DVC + MLflow, tres corridas independientes del nivel N2."""
import argparse
import os
from pathlib import Path
import time
import uuid

import mlflow
from mlflow.entities import Metric
import numpy as np
from prefect import flow, task

from pipeline import version_dataset
from race_env_v2 import DEFAULT_CONFIG, load_config
from training_v2 import ROOT, train_seed, write_json


@task(name="entrenar-rally-v2", persist_result=False)
def train_task(config, seed):
    return train_seed(config, seed)


@task(name="registrar-rally-v2", persist_result=False)
def track_task(result):
    config = result["config"]
    uri = os.environ.get("MLFLOW_TRACKING_URI", f"sqlite:///{ROOT / 'mlflow.db'}")
    mlflow.set_tracking_uri(uri)
    name = config["tracking"]["experiment_name"]
    if mlflow.get_experiment_by_name(name) is None:
        mlflow.create_experiment(name, artifact_location=(ROOT / "mlruns" / "artifacts-v2").as_uri() if uri.startswith("sqlite:") else None)
    mlflow.set_experiment(name)
    with mlflow.start_run(run_name=f"rally-v2-seed-{result['seed']}-{result['experiment_id']}") as run:
        mlflow.log_params({k: v for k, v in config["training"].items() if not isinstance(v, list)})
        mlflow.log_params({"environment_version": config["environment_version"], "reward_version": config["reward_version"], "max_steps": config["environment"]["max_steps"]})
        mlflow.set_tags({"dataset.sha256": result["metadata"]["dataset_sha256"], "model.sha256": result["metadata"]["model_sha256"], "config.sha256": result["metadata"]["config_sha256"], "dvc.pointer": result["dvc_pointer"], "source.git_head": result["metadata"]["source_git_head"]})
        client = mlflow.MlflowClient()
        timestamp = int(time.time() * 1000)
        batch = []
        for item in result["metrics"]:
            for key, value in item.items():
                if key not in ("episode", "termination_cause"):
                    batch.append(Metric(f"training_{key}", float(value), timestamp, item["episode"]))
            if len(batch) >= 500:
                client.log_batch(run.info.run_id, metrics=batch)
                batch = []
        if batch:
            client.log_batch(run.info.run_id, metrics=batch)
        mlflow.log_metrics({f"evaluation_{k}": v for k, v in result["evaluation"]["summary"].items()})
        mlflow.log_metrics({k: result["metadata"][k] for k in ("training_success_rate", "last_window_success_rate")})
        mlflow.log_artifacts(result["model_dir"], artifact_path="model")
        mlflow.log_artifact(result["dataset"], artifact_path="dataset")
        mlflow.log_artifact(str(ROOT / result["dvc_pointer"]), artifact_path="dataset")
        for name in result["metadata"]["source_sha256"]:
            mlflow.log_artifact(str(ROOT / name), artifact_path="source")
        result["mlflow_run_id"] = run.info.run_id
    return result


@flow(name="rally-v2-multiseed", log_prints=True, persist_result=False)
def rally_v2_pipeline(config_path=str(DEFAULT_CONFIG), episodes=None, seeds=None):
    config = load_config(config_path)
    if episodes is not None:
        config["training"]["episodes"] = episodes
    if seeds is not None:
        config["training"]["seeds"] = seeds
    config = load_config(config)
    suite_id = f"rally-v2-{uuid.uuid4().hex}"
    runs = []
    for seed in config["training"]["seeds"]:
        result = train_task(config, seed)
        result = version_dataset(result)
        result = track_task(result)
        runs.append(result)
        print(f"Semilla {seed}: {result['evaluation']['summary']}")
    stats = {}
    for key in runs[0]["evaluation"]["summary"]:
        values = [r["evaluation"]["summary"][key] for r in runs]
        stats[key] = {"mean": float(np.mean(values)), "sample_std": float(np.std(values, ddof=1)) if len(values) > 1 else None, "sample_variance": float(np.var(values, ddof=1)) if len(values) > 1 else None}
    report = {"suite_id": suite_id, "environment_version": config["environment_version"], "reward_version": config["reward_version"], "config": config, "between_seed_evaluation": stats, "runs": [{"seed": r["seed"], "experiment_id": r["experiment_id"], "mlflow_run_id": r["mlflow_run_id"], "dvc_pointer": r["dvc_pointer"], "metadata": r["metadata"]} for r in runs]}
    write_json(ROOT / "reports" / f"{suite_id}.json", report)
    # Static replay: observations and actions come from Python, never a second simulator.
    web = {**report, "runs": [{**entry, "evaluation": run["evaluation"], "training_replays": run["training_replays"]} for entry, run in zip(report["runs"], runs)]}
    write_json(ROOT / "rally-dashboard" / "dist" / "v2-results.json", web)
    print(f"Informe: reports/{suite_id}.json")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--episodes", type=int)
    parser.add_argument("--seeds", nargs="+", type=int)
    args = parser.parse_args()
    rally_v2_pipeline(args.config, args.episodes, args.seeds)
