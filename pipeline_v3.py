"""Prefect + DVC + MLflow para el nivel N3 (pista larga, 4 carriles, rampas y puente).

Secuencia (guía del profe, sección 14):
 1. validar la configuración y el ambiente
 2. entrenar 3 semillas independientes (+ referencias aleatoria y de reglas)
 3. versionar cada dataset con DVC y registrar cada corrida en MLflow
 4. aplicar los criterios de selección fijados ANTES de entrenar (están en la config)
 5. incidente controlado: lluvia -> medir la degradación -> probar dos intervenciones
      A) reentrenar solo con lluvia      B) reentrenar con clima mixto (50% lluvia)
    y aceptar/rechazar cada una con la misma regla, conservando las dos
 6. publicar el informe (reports/) y el archivo de reproducción para la web

Con --skip-tracking no se usan DVC ni MLflow (prueba o regenerar la web); los modelos
van a una carpeta ignorada y el informe lo dice, para no confundirlo con una corrida oficial.
"""
import argparse
import os
import time
import uuid

import numpy as np
from prefect import flow, task

from race_env_v3 import DEFAULT_CONFIG, apply_perturbation, load_config
from training_v3 import ROOT, train_seed, write_json

INTERVENTIONS = {
    "solo_lluvia": "A · reentrenar desde cero solo con lluvia",
    "clima_mixto": "B · reentrenar desde cero con clima mixto (cada episodio llueve con probabilidad 0.5)",
}


@task(name="entrenar-rally-v3", persist_result=False)
def train_task(config, seed, condition="normal", parent_run_id=None, output_root=ROOT):
    return train_seed(config, seed, output_root, condition=condition, parent_run_id=parent_run_id)


@task(name="versionar-dataset-rally-v3", persist_result=False)
def dvc_task(result):
    from pipeline import version_dataset  # reutiliza la tarea de v1 (dvc add) sin modificarla
    return version_dataset.fn(result)


@task(name="registrar-rally-v3", persist_result=False)
def track_task(result, role):
    import mlflow
    from mlflow.entities import Metric
    config = result["config"]
    uri = os.environ.get("MLFLOW_TRACKING_URI", f"sqlite:///{ROOT / 'mlflow.db'}")
    mlflow.set_tracking_uri(uri)
    name = config["tracking"]["experiment_name"]
    if mlflow.get_experiment_by_name(name) is None:
        mlflow.create_experiment(name, artifact_location=(ROOT / "mlruns" / "artifacts-v3").as_uri() if uri.startswith("sqlite:") else None)
    mlflow.set_experiment(name)
    meta = result["metadata"]
    with mlflow.start_run(run_name=f"rally-v3-{role}-seed-{result['seed']}-{result['experiment_id']}") as run:
        mlflow.log_params({k: v for k, v in config["training"].items() if not isinstance(v, list)})
        mlflow.log_params({"environment_version": config["environment_version"], "reward_version": config["reward_version"], "level_id": config["level_id"], "max_steps": config["environment"]["max_steps"], "lanes": config["environment"]["lanes"], "track_length_meters": config["environment"]["track_length_meters"], "training_condition": result["condition"]})
        mlflow.set_tags({"role": role, "hypothesis": config["experiment"]["hypothesis"], "change_vs_previous": config["experiment"]["change_vs_previous"], "dataset.sha256": meta["dataset_sha256"], "model.sha256": meta["model_sha256"], "config.sha256": meta["config_sha256"], "dvc.pointer": str(result.get("dvc_pointer")), "source.git_head": meta["source_git_head"], "parent_run_id": str(meta["parent_run_id"]), "evaluation_suite_id": meta["evaluation_suite_id"]})
        client = mlflow.MlflowClient()
        timestamp, batch = int(time.time() * 1000), []
        for item in result["metrics"]:
            for key, value in item.items():
                if key not in ("episode", "termination_cause"):
                    batch.append(Metric(f"training_{key}", float(value), timestamp, item["episode"]))
            if len(batch) >= 500:
                client.log_batch(run.info.run_id, metrics=batch)
                batch = []
        if batch:
            client.log_batch(run.info.run_id, metrics=batch)
        mlflow.log_metrics({f"evaluation_{k}": v for k, v in meta["evaluation"].items()})
        mlflow.log_metrics({f"lluvia_{k}": v for k, v in meta["evaluation_lluvia"].items()})
        for base, summary in meta["baselines"].items():
            mlflow.log_metrics({f"baseline_{base}_{k}": v for k, v in summary.items()})
        mlflow.log_metrics({k: meta[k] for k in ("training_success_rate", "last_window_success_rate")})
        mlflow.log_artifacts(result["model_dir"], artifact_path="model")
        mlflow.log_artifact(result["dataset"], artifact_path="dataset")
        if result.get("dvc_pointer"):
            mlflow.log_artifact(str(ROOT / result["dvc_pointer"]), artifact_path="dataset")
        for source in meta["source_sha256"]:
            mlflow.log_artifact(str(ROOT / source), artifact_path="source")
        result["mlflow_run_id"] = run.info.run_id
    return result


def mean_summary(summaries):
    return {key: float(np.mean([s[key] for s in summaries])) for key in summaries[0]}


def between_seeds(summaries):
    stats = {}
    for key in summaries[0]:
        values = [s[key] for s in summaries]
        stats[key] = {"mean": float(np.mean(values)), "sample_std": float(np.std(values, ddof=1)) if len(values) > 1 else None, "sample_variance": float(np.var(values, ddof=1)) if len(values) > 1 else None}
    return stats


def entry(r):
    return {"seed": r["seed"], "condition": r["condition"], "experiment_id": r["experiment_id"], "mlflow_run_id": r["mlflow_run_id"], "dvc_pointer": r["dvc_pointer"], "metadata": r["metadata"]}


def scenario(sid, label, layout, mode, replay):
    return {"id": sid, "label": label, "layout": layout, "mode": mode, "episode": replay["episode"], "frames": replay["frames"]}


def build_scenarios(run, fixes):
    """Escenarios para reproducir en la web, cada uno con la pista (layout) en que ocurrió."""
    out = [scenario(f"eval-{r['episode']}", f"Evaluación · condiciones normales · episodio {r['episode']}", "normal", "evaluation", r) for r in run["evaluation"]["replays"]]
    out += [scenario("reglas", "Referencia de reglas (no aprende) · condiciones normales", "normal", "baseline", r) for r in run["baselines"]["reglas"]["replays"]]
    out += [scenario("lluvia-original", "Incidente: lluvia con el modelo original", "lluvia", "incident", r) for r in run["evaluation_lluvia"]["replays"]]
    if "solo_lluvia" in fixes:
        a = fixes["solo_lluvia"]
        out += [scenario("A-lluvia", "Intervención A (solo lluvia) · bajo lluvia", "lluvia", "intervention", r) for r in a["evaluation_lluvia"]["replays"][:1]]
        out += [scenario("A-normal", "Intervención A (solo lluvia) · pista normal: ¡olvidó la pista!", "normal", "intervention", r) for r in a["evaluation"]["replays"][:1]]
    if "clima_mixto" in fixes:
        b = fixes["clima_mixto"]
        out += [scenario("B-lluvia", "Intervención B (clima mixto) · bajo lluvia", "lluvia", "intervention", r) for r in b["evaluation_lluvia"]["replays"][:1]]
        out += [scenario("B-normal", "Intervención B (clima mixto) · pista normal", "normal", "intervention", r) for r in b["evaluation"]["replays"][:1]]
    out += [scenario(f"train-{r['episode']}", f"Entrenamiento · episodio {r['episode']}", "normal", "training", r) for r in run["training_replays"]]
    return out


@flow(name="rally-v3-multiseed", log_prints=True, persist_result=False)
def rally_v3_pipeline(config_path=str(DEFAULT_CONFIG), episodes=None, seeds=None, skip_tracking=False, incident=True):
    config = load_config(config_path)                      # 1. validar
    if episodes is not None:
        config["training"]["episodes"] = episodes
    if seeds is not None:
        config["training"]["seeds"] = seeds
    config = load_config(config)
    suite_id = f"rally-v3-{uuid.uuid4().hex}"
    output_root = ROOT / ".prueba-sin-tracking" if skip_tracking else ROOT
    runs, fixes = [], {}

    def process(result, role):                             # 3. DVC + MLflow
        if skip_tracking:
            result["dvc_pointer"], result["mlflow_run_id"] = None, None
            return result
        return track_task(dvc_task(result), role)

    for seed in config["training"]["seeds"]:               # 2. entrenar
        result = process(train_task(config, seed, output_root=output_root), "candidato")
        runs.append(result)
        print(f"Semilla {seed}: normal {result['evaluation']['summary']} | lluvia {result['evaluation_lluvia']['summary']}")
        if incident:                                       # 5. intervenciones
            fixes[seed] = {}
            for condition in INTERVENTIONS:
                fixed = process(train_task(config, seed, condition, result["experiment_id"], output_root), f"intervencion-{condition}")
                fixes[seed][condition] = fixed
                print(f"   {condition}: normal {fixed['evaluation']['summary']} | lluvia {fixed['evaluation_lluvia']['summary']}")

    criteria = config["experiment"]["selection_criteria"]  # 4. criterio fijado antes
    summaries = [r["evaluation"]["summary"] for r in runs]
    mean = mean_summary(summaries)
    reglas = mean_summary([r["metadata"]["baselines"]["reglas"] for r in runs])
    aleatoria = mean_summary([r["metadata"]["baselines"]["aleatoria"] for r in runs])
    selection = {"criteria": criteria, "mean_success_rate": mean["success_rate"], "return_margin_over_rules": mean["mean_return"] - reglas["mean_return"],
                 "accepted": bool(mean["success_rate"] >= criteria["min_success_rate"] and mean["mean_return"] - reglas["mean_return"] >= criteria["min_return_margin_over_rules"])}
    report = {"suite_id": suite_id, "environment_version": config["environment_version"], "reward_version": config["reward_version"], "level_id": config["level_id"],
              "tracking": "omitido (--skip-tracking): sin DVC ni MLflow, no es corrida oficial" if skip_tracking else "DVC + MLflow",
              "config": config, "between_seed_evaluation": between_seeds(summaries), "baselines": {"aleatoria": aleatoria, "reglas": reglas}, "selection": selection,
              "runs": [entry(r) for r in runs]}
    if incident:
        before = mean
        degraded = mean_summary([r["metadata"]["evaluation_lluvia"] for r in runs])
        options = {}
        for condition, label in INTERVENTIONS.items():
            group = [fixes[s][condition] for s in fixes]
            rain = mean_summary([g["metadata"]["evaluation_lluvia"] for g in group])
            normal = mean_summary([g["metadata"]["evaluation"] for g in group])
            recovers = rain["success_rate"] >= criteria["min_success_rate"] and rain["mean_return"] >= 0.9 * before["mean_return"]
            keeps_normal = normal["success_rate"] >= criteria["min_success_rate"]
            reason = ("recupera el rendimiento bajo lluvia y no empeora en la pista normal" if recovers and keeps_normal
                      else "recupera bajo lluvia pero empeora en la pista normal (olvida la pista original)" if recovers
                      else "no recupera el rendimiento bajo lluvia")
            options[condition] = {"label": label, "under_rain": rain, "under_normal": normal, "accepted": bool(recovers and keeps_normal), "reason": reason, "runs": [entry(g) for g in group]}
        chosen = next((k for k, v in options.items() if v["accepted"]), None)
        report["incident"] = {"perturbation": "lluvia", "description": config["perturbations"]["lluvia"]["descripcion"], "before": before, "degraded": degraded,
                              "rule": f"Se acepta una intervención si bajo lluvia logra éxito ≥ {criteria['min_success_rate']:.0%} y al menos el 90% del retorno original, y en la pista normal sigue con éxito ≥ {criteria['min_success_rate']:.0%}.",
                              "interventions": options, "chosen": chosen,
                              "decision": f"Se promueve la intervención {options[chosen]['label']}" if chosen else "Ninguna intervención cumple: se conserva el modelo original"}
    write_json(ROOT / "reports" / f"{suite_id}.json", report)   # 6. publicar
    # Reproducción estática: observaciones y acciones salen de Python, nunca de un segundo simulador.
    web = {**report, "layouts": {"normal": config["environment"]["lane_layout"], "lluvia": apply_perturbation(config, "lluvia")["environment"]["lane_layout"]},
           "runs": [{**entry(run), "scenarios": build_scenarios(run, fixes.get(run["seed"], {}))} for run in runs]}
    if incident:
        web["incident"] = {**report["incident"], "interventions": {k: {kk: vv for kk, vv in v.items() if kk != "runs"} for k, v in report["incident"]["interventions"].items()}}
    write_json(ROOT / "rally-dashboard" / "dist" / "v3-results.json", web)
    print(f"Informe: reports/{suite_id}.json | Selección: {'ACEPTADO' if selection['accepted'] else 'RECHAZADO'}")
    if incident:
        print(f"Incidente: {report['incident']['decision']}")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Pipeline Rally v3 (N3)")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--episodes", type=int)
    parser.add_argument("--seeds", nargs="+", type=int)
    parser.add_argument("--skip-tracking", action="store_true", help="No usa DVC ni MLflow (prueba rápida)")
    parser.add_argument("--no-incident", action="store_true", help="Omite el incidente de lluvia y las intervenciones")
    args = parser.parse_args()
    rally_v3_pipeline(args.config, args.episodes, args.seeds, args.skip_tracking, not args.no_incident)
