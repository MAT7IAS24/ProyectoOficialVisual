"""Prefect + DVC + MLflow para el nivel N5 (llantas realistas: Pacejka, círculo de agarre, barro con surcos).

 1. validar la configuración y generar la suite fija de 30 pistas (las MISMAS semillas que el N4, para comparar)
 2. por cada semilla: entrenar PPO (SB3) y Q-learning con el MISMO presupuesto de pasos
 3. evaluar todo en la misma suite: condiciones normales, lluvia y sensores con ruido
 4. empaquetar cada modelo (pesos, normalización, ONNX verificado, manifiesto) y registrarlo en MLflow;
    el PPO recomendado se registra en el Model Registry como "autonomous-rally-ppo"
 5. versionar con DVC la suite de pistas y la tabla de resultados por caso
 6. aplicar el criterio fijado antes de entrenar (barro sin diagonal, reglas ≥ 80 %, PPO no peor que el N4)
    y publicar informe + archivo de la web

Con --skip-tracking no usa DVC ni MLflow (prueba); el informe lo indica.
"""
import argparse
import os
from pathlib import Path
import time
import uuid

import numpy as np
from prefect import flow, task

from race_env_v5 import DEFAULT_CONFIG, load_config
from training_v5 import (ROOT, evaluate, evaluation_layouts, package, random_policy, rule_policy, train_ppo,
                         train_qlearning, write_eval_csv, write_json)

CONDITIONS = (None, "lluvia", "sensor_ruidoso")


def cond_name(c):
    return c or "normal"


@task(name="entrenar-ppo-v5", persist_result=False)
def ppo_task(config, seed, layouts, output_root):
    return train_ppo(config, seed, output_root, layouts)


@task(name="entrenar-qlearning-v5", persist_result=False)
def q_task(config, seed, layouts, output_root):
    return train_qlearning(config, seed, output_root, layouts)


@task(name="evaluar-v5", persist_result=False)
def eval_task(result, config, layouts, keep=()):
    return {cond_name(c): evaluate(result["policy_factory"], config, layouts, perturbation=c, keep=keep if c is None else (0,), seed=result["seed"])
            for c in CONDITIONS}


@task(name="versionar-suite-v5", persist_result=False)
def dvc_task(folder):
    import subprocess, sys
    rel = [str(p.relative_to(ROOT)) for p in sorted(folder.iterdir()) if p.suffix in (".json", ".csv")]
    subprocess.run([sys.executable, "-m", "dvc", "add", *rel], cwd=ROOT, check=True, capture_output=True, text=True)
    return [r + ".dvc" for r in rel]


@task(name="registrar-v5", persist_result=False)
def mlflow_task(result, evaluations, manifest, config, role, register=False):
    import mlflow
    from mlflow.entities import Metric
    uri = os.environ.get("MLFLOW_TRACKING_URI", f"sqlite:///{ROOT / 'mlflow.db'}")
    mlflow.set_tracking_uri(uri)
    name = config["tracking"]["experiment_name"]
    if mlflow.get_experiment_by_name(name) is None:
        mlflow.create_experiment(name, artifact_location=(ROOT / "mlruns" / "artifacts-v5").as_uri() if uri.startswith("sqlite:") else None)
    mlflow.set_experiment(name)
    algo = result["algorithm"]
    with mlflow.start_run(run_name=f"rally-v5-{algo}-seed-{result['seed']}-{result['run_id'][-8:]}") as run:
        params = {"algorithm": algo, "seed": result["seed"], "timesteps": result["timesteps"], "environment_version": config["environment_version"],
                  "reward_version": config["reward_version"], "level_id": config["level_id"]}
        params.update({f"ppo_{k}": str(v) for k, v in config["training"]["ppo"].items()} if algo == "ppo" else
                      {f"q_{k}": str(v) for k, v in config["training"]["qlearning"].items()})
        mlflow.log_params(params)
        mlflow.set_tags({"role": role, "hypothesis": config["experiment"]["hypothesis"], "change_vs_previous": config["experiment"]["change_vs_previous"],
                         "model.sha256": manifest["model_sha256"], "config.sha256": manifest["config_sha256"], "source.git_head": manifest["git_commit"],
                         "evaluation_suite_id": manifest["evaluation_suite_id"], "parent_run_id": "None"})
        client, ts = mlflow.MlflowClient(), int(time.time() * 1000)
        batch = []
        for point in result["train_curve"]:
            batch += [Metric("train_success_rate", point["success_rate"], ts, point["timesteps"]), Metric("train_mean_return", point["mean_return"], ts, point["timesteps"])]
        for point in result["eval_curve"]:
            batch += [Metric("eval_success_rate", point["success_rate"], ts, point["timesteps"]), Metric("eval_mean_return", point["mean_return"], ts, point["timesteps"])]
        if batch:
            client.log_batch(run.info.run_id, metrics=batch)
        for cond, ev in evaluations.items():
            mlflow.log_metrics({f"{cond}_{k}": v for k, v in ev["summary"].items() if v is not None})
        mlflow.log_artifacts(str(result["folder"]), artifact_path="model")
        if register:
            mlflow.register_model(f"runs:/{run.info.run_id}/model", "autonomous-rally-ppo")
        return run.info.run_id


def mean_summary(items):
    keys = items[0].keys()
    out = {}
    for k in keys:
        vals = [i[k] for i in items if i[k] is not None]
        out[k] = float(np.mean(vals)) if vals else None
    return out


def stats(items, key):
    vals = [i[key] for i in items]
    return {"mean": float(np.mean(vals)), "sample_std": float(np.std(vals, ddof=1)) if len(vals) > 1 else None}


@flow(name="rally-v5-llantas-realistas", log_prints=True, persist_result=False)
def rally_v5_pipeline(config_path=str(DEFAULT_CONFIG), timesteps=None, seeds=None, skip_tracking=False):
    config = load_config(config_path)
    if timesteps:
        config["training"]["ppo"]["total_timesteps"] = timesteps
    if seeds:
        config["training"]["seeds"] = seeds
    config = load_config(config)
    suite_id = f"rally-v5-{uuid.uuid4().hex}"
    output_root = ROOT / ".prueba-sin-tracking" if skip_tracking else ROOT
    layouts = evaluation_layouts(config)
    print(f"Suite fija: {len(layouts)} pistas (semillas {layouts[0]['seed']}…{layouts[-1]['seed']})")

    results = []
    for seed in config["training"]["seeds"]:
        for kind, fn in (("ppo", ppo_task), ("qlearning", q_task)):
            res = fn(config, seed, layouts, output_root)
            evs = eval_task(res, config, layouts, keep=(0, 1, 2))
            res["evaluations"] = evs
            res["manifest"] = package(res, config, evs)
            print(f"{kind} semilla {seed}: normal {evs['normal']['summary']['success_rate']:.0%} · lluvia {evs['lluvia']['summary']['success_rate']:.0%} · ruido {evs['sensor_ruidoso']['summary']['success_rate']:.0%}")
            results.append(res)

    rng = np.random.default_rng(0)
    baselines = {"aleatoria": evaluate(lambda e: random_policy(e, rng), config, layouts, keep=()),
                 "reglas": evaluate(rule_policy, config, layouts, keep=(0, 1, 2)),
                 "reglas_lluvia": evaluate(rule_policy, config, layouts, perturbation="lluvia", keep=())}

    by = {k: [r for r in results if r["algorithm"] == k] for k in ("ppo", "qlearning")}
    summary = {k: {c: mean_summary([r["evaluations"][c]["summary"] for r in v]) for c in ("normal", "lluvia", "sensor_ruidoso")} for k, v in by.items()}
    between = {k: {m: stats([r["evaluations"]["normal"]["summary"] for r in v], m) for m in ("success_rate", "mean_return")} for k, v in by.items()}
    crit = config["experiment"]["selection_criteria"]
    ppo_s, q_s = summary["ppo"]["normal"]["success_rate"], summary["qlearning"]["normal"]["success_rate"]
    best = max(by["ppo"], key=lambda r: (r["evaluations"]["normal"]["summary"]["success_rate"], r["evaluations"]["normal"]["summary"]["mean_return"]))
    rules = baselines["reglas"]["summary"]
    n4 = config["experiment"]["n4_reference"]
    checks = {"barro_sin_diagonal": bool(rules["mean_mud_course_deg"] is not None and rules["mean_mud_course_deg"] < crit["max_mean_mud_course_deg"]),
              "reglas_conservan_exito": bool(rules["success_rate"] >= crit["min_success_rate_rules"]),
              "ppo_no_empeora_vs_n4": bool(ppo_s >= crit["n4_ppo_success_rate"] - crit["ppo_not_worse_than_n4_by"])}
    selection = {"criteria": crit, "checks": checks, "accepted": all(checks.values()),
                 "rules_success_rate": rules["success_rate"], "rules_mud_course_deg": rules["mean_mud_course_deg"],
                 "rules_mud_lateral_mps": rules["mean_mud_lateral_mps"], "ppo_success_rate": ppo_s, "qlearning_success_rate": q_s,
                 "n4_reference": n4, "recommended_run_id": best["run_id"], "recommended_seed": best["seed"]}

    # DVC: suite de pistas + resultados por caso (los datos de este experimento de RL).
    data_dir = output_root / "data" / "experiments" / suite_id
    write_json(data_dir / "escenarios_evaluacion.json", {"suite": "rally-v5-suite-1", "layouts": layouts})
    all_evals = {f"{r['algorithm']}_seed{r['seed']}_{c}": ev for r in results for c, ev in r["evaluations"].items()}
    all_evals.update({f"baseline_{k}": v for k, v in baselines.items()})
    write_eval_csv(data_dir / "resultados_por_caso.csv", all_evals)
    dvc_pointers = None
    if not skip_tracking:
        dvc_pointers = dvc_task(data_dir)
        for r in results:
            role = "recomendado" if r is best else r["algorithm"]
            r["mlflow_run_id"] = mlflow_task(r, r["evaluations"], r["manifest"], config, role, register=r is best)
    for r in results:
        r.setdefault("mlflow_run_id", None)

    report = {"suite_id": suite_id, "environment_version": "rally-v5", "reward_version": "v5", "level_id": "N5",
              "tracking": "omitido (--skip-tracking): sin DVC ni MLflow, no es corrida oficial" if skip_tracking else "DVC + MLflow",
              "config": config, "selection": selection, "summary": summary, "between_seeds": between,
              "baselines": {k: v["summary"] for k, v in baselines.items()},
              "slip_by_terrain": {"reglas": baselines["reglas"]["slip_by_terrain"], "ppo_recomendado": best["evaluations"]["normal"]["slip_by_terrain"]},
              "dvc_pointers": dvc_pointers,
              "runs": [{"algorithm": r["algorithm"], "seed": r["seed"], "run_id": r["run_id"], "mlflow_run_id": r["mlflow_run_id"],
                        "manifest": r["manifest"], "evaluation": {c: ev["summary"] for c, ev in r["evaluations"].items()},
                        "curves": {"entrenamiento": r["train_curve"], "evaluacion": r["eval_curve"]}} for r in results]}
    write_json(ROOT / "reports" / f"{suite_id}.json", report)

    # Archivo de la web: reproducciones reales (Python decide; la web solo dibuja).
    q_best = max(by["qlearning"], key=lambda r: r["evaluations"]["normal"]["summary"]["mean_return"])
    from race_env_v5 import Track
    track = Track(config["track"]["straight_m"], config["track"]["radius_m"])
    samples = [[round(v, 3) for v in track.center(s)] for s in np.arange(0, track.length, 2.0)]
    scenarios = []
    for i in (0, 1, 2):
        scenarios.append({"id": f"ppo-vs-q-{i}", "label": f"PPO vs Q-learning · pista nueva #{i + 1}", "mode": "evaluation", "policy": "PPO", "layout": layouts[i],
                          "frames": best["evaluations"]["normal"]["replays"][i]["frames"],
                          "ghost": {"policy": "Q-learning", "frames": q_best["evaluations"]["normal"]["replays"][i]["frames"]}})
    # Antes y después: las reglas en la MISMA pista con la física del N4 (fantasma) y la del N5.
    import json as _json
    v4_web = ROOT / "rally-dashboard" / "dist" / "v4-results.json"
    if v4_web.exists():
        old = {sc["id"]: sc for sc in _json.loads(v4_web.read_text(encoding="utf-8"))["scenarios"]}
        for i in (0, 1):
            if f"reglas-{i}" in old and old[f"reglas-{i}"]["layout"]["ground"] == layouts[i]["ground"]:
                scenarios.append({"id": f"antes-despues-{i}", "label": f"Antes (N4) y ahora (N5) · reglas · pista nueva #{i + 1}", "mode": "compare",
                                  "policy": "Reglas N5", "layout": layouts[i], "frames": baselines["reglas"]["replays"][i]["frames"],
                                  "ghost": {"policy": "Reglas N4 (física vieja)", "frames": old[f"reglas-{i}"]["frames"]}})
    for i in (0, 1):
        scenarios.append({"id": f"reglas-{i}", "label": f"Referencia de reglas · pista nueva #{i + 1}", "mode": "baseline", "policy": "Reglas", "layout": layouts[i],
                          "frames": baselines["reglas"]["replays"][i]["frames"]})
    scenarios.append({"id": "ppo-lluvia", "label": "PPO con lluvia (menos agarre) · pista nueva #1", "mode": "incident", "policy": "PPO", "layout": layouts[0],
                      "frames": best["evaluations"]["lluvia"]["replays"][0]["frames"]})
    scenarios.append({"id": "ppo-ruido", "label": "PPO con sensores ruidosos · pista nueva #1", "mode": "incident", "policy": "PPO", "layout": layouts[0],
                      "frames": best["evaluations"]["sensor_ruidoso"]["replays"][0]["frames"]})
    web = {k: report[k] for k in ("suite_id", "environment_version", "reward_version", "level_id", "tracking", "selection", "summary", "between_seeds", "baselines")}
    web.update({"config": {k: config[k] for k in ("experiment", "track", "physics", "terrains", "reward", "episode", "perturbations", "training")},
                "track_samples": samples, "track_length": track.length, "scenarios": scenarios,
                "runs": [{k: v for k, v in run.items() if k != "manifest"} | {"model_sha256": run["manifest"]["model_sha256"], "onnx": run["manifest"].get("browser_model_uri")} for run in report["runs"]]})
    write_json(ROOT / "rally-dashboard" / "dist" / "v5-results.json", web)
    print(f"Informe: reports/{suite_id}.json | reglas {rules['success_rate']:.0%}, barro {rules['mean_mud_course_deg']:.1f}° | PPO {ppo_s:.0%} vs Q-learning {q_s:.0%} | {'ACEPTADO' if selection['accepted'] else 'RECHAZADO'}")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Pipeline Rally v5 (N5): llantas realistas")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--timesteps", type=int, help="Presupuesto de pasos por modelo (prueba rápida)")
    parser.add_argument("--seeds", nargs="+", type=int)
    parser.add_argument("--skip-tracking", action="store_true", help="No usa DVC ni MLflow")
    args = parser.parse_args()
    rally_v5_pipeline(args.config, args.timesteps, args.seeds, args.skip_tracking)
