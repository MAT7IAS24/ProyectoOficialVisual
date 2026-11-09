"""Reproducible N5 flow: sparse Q-learning, DVC, MLflow and replay dashboard."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

import numpy as np
from prefect import flow, task

from race_env_v5 import DEFAULT_CONFIG, load_config
from training_v5 import ROOT, train_seed, write_json


@task(name="entrenar-rally-v5", persist_result=False)
def train_task(config, seed, output_root=ROOT):
    return train_seed(config, seed, output_root)


@task(name="versionar-dataset-rally-v5", persist_result=False)
def dvc_task(result):
    from pipeline import version_dataset
    return version_dataset.fn(result)


@task(name="registrar-rally-v5", persist_result=False)
def track_task(result):
    import mlflow
    from mlflow.entities import Metric

    config = result["config"]
    tracking_uri = os.environ.get("MLFLOW_TRACKING_URI", f"sqlite:///{ROOT / 'mlflow.db'}")
    mlflow.set_tracking_uri(tracking_uri)
    experiment_name = config["tracking"]["experiment_name"]
    if mlflow.get_experiment_by_name(experiment_name) is None:
        artifact_location = (
            (ROOT / "mlruns" / "artifacts-v5").as_uri()
            if tracking_uri.startswith("sqlite:") else None
        )
        mlflow.create_experiment(experiment_name, artifact_location=artifact_location)
    mlflow.set_experiment(experiment_name)
    metadata = result["metadata"]
    with mlflow.start_run(run_name=result["experiment_id"]) as run:
        mlflow.log_params({
            "environment_version": config["environment_version"],
            "reward_version": config["reward_version"],
            "episodes": config["training"]["episodes"],
            "seed": result["seed"],
            "alpha": config["training"]["alpha"],
            "gamma": config["training"]["gamma"],
            "weather_mix_probability": config["training"]["weather_mix_probability"],
            "state_count": metadata["state_count"],
            "stored_state_count": metadata["stored_state_count"],
        })
        mlflow.set_tags({
            "dataset.sha256": metadata["dataset_sha256"],
            "model.sha256": metadata["model_sha256"],
            "config.sha256": metadata["config_sha256"],
            "dvc.pointer": result["dvc_pointer"],
            "source.git_head": metadata["source_git_head"],
            "evaluation_suite_id": metadata["evaluation_suite_id"],
        })
        client = mlflow.MlflowClient()
        timestamp = int(time.time() * 1000)
        batch = []
        for item in result["metrics"]:
            for key in ("return", "steps", "success", "fuel", "accidents", "epsilon", "mean_abs_td_error", "visited_states", "rain"):
                batch.append(Metric(f"training_{key}", float(item[key]), timestamp, item["episode"]))
            if len(batch) >= 500:
                client.log_batch(run.info.run_id, metrics=batch)
                batch = []
        if batch:
            client.log_batch(run.info.run_id, metrics=batch)
        for weather, evaluation in (
            ("normal", metadata["evaluation"]),
            ("lluvia", metadata["evaluation_lluvia"]),
        ):
            mlflow.log_metrics({
                f"evaluation_{weather}_{key}": value
                for key, value in evaluation.items()
            })
        mlflow.log_metrics({
            "training_success_rate": metadata["training_success_rate"],
            "last_window_success_rate": metadata["last_window_success_rate"],
        })
        mlflow.log_artifacts(result["model_dir"], artifact_path="model")
        mlflow.log_artifact(result["dataset"], artifact_path="dataset")
        mlflow.log_artifact(str(ROOT / result["dvc_pointer"]), artifact_path="dataset")
        for source in metadata["source_sha256"]:
            mlflow.log_artifact(str(ROOT / source), artifact_path="source")
        result["mlflow_run_id"] = run.info.run_id
    return result


def mean_summary(summaries):
    return {
        key: float(np.mean([summary[key] for summary in summaries]))
        for key in summaries[0]
    }


def between_seeds(summaries):
    stats = {}
    for key in summaries[0]:
        values = [summary[key] for summary in summaries]
        stats[key] = {
            "mean": float(np.mean(values)),
            "sample_std": float(np.std(values, ddof=1)) if len(values) > 1 else None,
            "sample_variance": float(np.var(values, ddof=1)) if len(values) > 1 else None,
        }
    return stats


def run_entry(result):
    return {
        "seed": result["seed"],
        "experiment_id": result["experiment_id"],
        "mlflow_run_id": result["mlflow_run_id"],
        "dvc_pointer": result["dvc_pointer"],
        "metadata": result["metadata"],
    }


def scenario(sid, label, layout, mode, replay):
    return {
        "id": sid,
        "label": label,
        "layout": layout,
        "mode": mode,
        "episode": replay["episode"],
        "frames": replay["frames"],
    }


def build_scenarios(result):
    scenarios = [
        scenario(
            f"normal-{replay['episode']}",
            f"Evaluación · pista normal · episodio {replay['episode']}",
            "normal", "evaluation", replay,
        )
        for replay in result["evaluation"]["replays"]
    ]
    scenarios += [
        scenario(
            f"rain-{replay['episode']}",
            f"Evaluación · lluvia · episodio {replay['episode']}",
            "lluvia", "incident", replay,
        )
        for replay in result["evaluation_lluvia"]["replays"]
    ]
    for weather, layout in (("normal", "normal"), ("lluvia", "lluvia")):
        baseline = result["baselines"][weather]["reglas"]
        scenarios.extend(
            scenario(
                f"rules-{weather}-{replay['episode']}",
                f"Referencia de reglas · {weather} · episodio {replay['episode']}",
                layout, "baseline", replay,
            )
            for replay in baseline["replays"]
        )
    scenarios.extend(
        scenario(
            f"training-{replay['episode']}",
            f"Entrenamiento · {replay['weather']} · episodio {replay['episode']}",
            replay["weather"], "training", replay,
        )
        for replay in result["training_replays"]
    )
    return scenarios


@flow(name="rally-v5-multiseed", log_prints=True, persist_result=False)
def rally_v5_pipeline(config_path=str(DEFAULT_CONFIG), episodes=None, seeds=None, skip_tracking=False):
    config = load_config(config_path)
    if episodes is not None:
        config["training"]["episodes"] = episodes
    if seeds is not None:
        config["training"]["seeds"] = seeds
    config = load_config(config)
    suite_id = f"rally-v5-{uuid.uuid4().hex}"
    output_root = ROOT / ".prueba-sin-tracking" if skip_tracking else ROOT
    results = []
    for seed in config["training"]["seeds"]:
        result = train_task(config, seed, output_root)
        if skip_tracking:
            result["dvc_pointer"] = None
            result["mlflow_run_id"] = None
        else:
            result = dvc_task(result)
            result = track_task(result)
        results.append(result)
        print(
            f"Semilla {seed}: normal {result['evaluation']['summary']} | "
            f"lluvia {result['evaluation_lluvia']['summary']}"
        )

    normal = mean_summary([result["metadata"]["evaluation"] for result in results])
    rain = mean_summary([result["metadata"]["evaluation_lluvia"] for result in results])
    baselines = {
        weather: {
            name: mean_summary([
                result["metadata"]["baselines"][weather][name]
                for result in results
            ])
            for name in ("aleatoria", "reglas")
        }
        for weather in ("normal", "lluvia")
    }
    criteria = config["experiment"]["selection_criteria"]
    selection = {
        "criteria": criteria,
        "normal_success_rate": normal["success_rate"],
        "rain_success_rate": rain["success_rate"],
        "accepted": bool(
            normal["success_rate"] >= criteria["min_success_rate_normal"]
            and rain["success_rate"] >= criteria["min_success_rate_rain"]
        ),
    }
    report = {
        "suite_id": suite_id,
        "environment_version": config["environment_version"],
        "reward_version": config["reward_version"],
        "level_id": config["level_id"],
        "tracking": (
            "omitido (--skip-tracking): sin DVC ni MLflow; corrida de prueba"
            if skip_tracking else "DVC + MLflow"
        ),
        "config": config,
        "evaluation": {
            "normal": normal,
            "lluvia": rain,
        },
        "between_seed_evaluation": {
            "normal": between_seeds([result["metadata"]["evaluation"] for result in results]),
            "lluvia": between_seeds([result["metadata"]["evaluation_lluvia"] for result in results]),
        },
        "baselines": baselines,
        "selection": selection,
        "runs": [run_entry(result) for result in results],
    }
    report_path = ROOT / "reports" / f"{suite_id}.json"
    write_json(report_path, report)
    web = {
        **report,
        "layouts": {
            "normal": config["environment"]["lane_layout"],
            "lluvia": load_config(config, "lluvia")["environment"]["lane_layout"],
        },
        "runs": [
            {
                **run_entry(result),
                "training_metrics": result["metrics"],
                "scenarios": build_scenarios(result),
            }
            for result in results
        ],
    }
    write_json(ROOT / "rally-dashboard" / "dist" / "v5-results.json", web)
    print(f"Informe: {report_path.relative_to(ROOT)}")
    print(f"Selección: {'ACEPTADO' if selection['accepted'] else 'RECHAZADO'}")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Pipeline Rally v5 / N5")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--episodes", type=int)
    parser.add_argument("--seeds", nargs="+", type=int)
    parser.add_argument(
        "--skip-tracking",
        action="store_true",
        help="Prueba rápida sin DVC ni MLflow; no es una corrida oficial",
    )
    args = parser.parse_args()
    rally_v5_pipeline(args.config, args.episodes, args.seeds, args.skip_tracking)
