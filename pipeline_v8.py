"""Prefect + DVC + MLflow para el nivel N8 ("Superar al maestro": más entrenamiento, parada temprana y libro de episodios).

 1. validar la configuración y generar la suite fija de 30 pistas (las MISMAS del N4 al N7)
 2. por cada semilla: imitación (DAgger) con parada temprana y práctica con PPO con parada temprana;
    se cuenta cada episodio y cómo terminó
 3. evaluar en la suite: condiciones normales, lluvia y sensores con ruido (vueltas completas, vueltas
    LIMPIAS, tiempo de vuelta, accidentes)
 4. correr en las mismas pistas las referencias: reglas (el maestro), azar y el modelo recomendado del N7
 5. empaquetar cada modelo (pesos, normalización, ONNX verificado, manifiesto con episodios y parada temprana)
 6. aplicar el criterio fijado antes de entrenar y publicar informe + archivo de la web

Con --skip-tracking no usa DVC ni MLflow (prueba); el informe lo indica.
"""
import argparse
import json
from pathlib import Path
import uuid

import numpy as np
from prefect import flow, task

from race_env_v7 import Track
from race_env_v8 import DEFAULT_CONFIG, load_config
from training_v7 import ROOT, random_policy, rule_policy, write_eval_csv, write_json
from training_v8 import CAUSES, evaluate_v8, evaluation_layouts, load_trained, package, packaged_policy_factory, train_ppo

CONDITIONS = (None, "lluvia", "sensor_ruidoso")
N7_MODEL = ROOT / "rally-dashboard" / "dist" / "modelos" / "n7" / "ppo-recomendado"


def cond_name(c):
    return c or "normal"


@task(name="entrenar-ppo-v8", persist_result=False)
def ppo_task(config, seed, output_root):
    done = load_trained(config, seed, output_root)
    if done:
        print(f"Semilla {seed}: ya estaba entrenada ({done['run_id']}); se carga sin repetir.")
    return done or train_ppo(config, seed, output_root)


@task(name="evaluar-v8", persist_result=False)
def eval_task(factory, config, layouts, seed, keep=()):
    return {cond_name(c): evaluate_v8(factory, config, layouts, perturbation=c, keep=keep if c is None else (0,), seed=seed) for c in CONDITIONS}


@task(name="versionar-suite-v8", persist_result=False)
def dvc_task(folder):
    import subprocess, sys
    rel = [str(p.relative_to(ROOT)) for p in sorted(folder.iterdir()) if p.suffix in (".json", ".csv")]
    subprocess.run([sys.executable, "-m", "dvc", "add", *rel], cwd=ROOT, check=True, capture_output=True, text=True)
    return [r + ".dvc" for r in rel]


@task(name="registrar-en-mlflow-v8", persist_result=False)
def mlflow_task(result, manifest, config, role, register=False):
    import mlflow
    mlflow.set_tracking_uri(f"sqlite:///{(ROOT / 'mlflow.db').as_posix()}")
    mlflow.set_experiment("autonomous-rally-v8")
    with mlflow.start_run(run_name=f"{role}-seed-{result['seed']}") as run:
        mlflow.set_tags({"level_id": "N8", "environment_version": "rally-v8", "reward_version": config["reward_version"], "algorithm": "ppo",
                         "role": role, "seed": str(result["seed"]), "run_id_local": result["run_id"], "early_stopped": str(result["early_stopping"]["stopped_early"])})
        mlflow.log_params({f"ppo.{k}": str(v) for k, v in config["training"]["ppo"].items()})
        mlflow.log_params({f"imitation.{k}": str(v) for k, v in config["training"]["imitation"].items()})
        for cond, ev in result["evaluations"].items():
            for k in ("success_rate", "clean_rate", "mean_accidents", "mean_time_s_success", "mean_return"):
                if ev["summary"].get(k) is not None:
                    mlflow.log_metric(f"{cond}.{k}", ev["summary"][k])
        mlflow.log_metric("train.episodes", result["episodes"]["total"]["episodes"])
        mlflow.log_metric("train.steps", result["episodes"]["total"]["steps"])
        for p in result["eval_curve"]:
            mlflow.log_metric("validation.clean_rate", p["validation_clean_rate"], step=p["timesteps"])
            mlflow.log_metric("validation.success_rate", p["validation_success_rate"], step=p["timesteps"])
        mlflow.log_artifacts(str(result["folder"]), artifact_path="model")
        if register:
            mlflow.register_model(f"runs:/{run.info.run_id}/model", "autonomous-rally-ppo")
        return run.info.run_id


def mean_summary(items):
    out = {}
    for k in items[0].keys():
        vals = [i[k] for i in items if i[k] is not None]
        if vals and isinstance(vals[0], dict):
            names = sorted({n for v in vals for n in v})
            out[k] = {n: float(np.mean([v.get(n, 0) for v in vals])) for n in names}
            continue
        out[k] = float(np.mean(vals)) if vals else None
    return out


def add_ledgers(ledgers):
    """Suma los libros de episodios de todas las semillas, por fase y por causa de fin."""
    out = {}
    for led in ledgers:
        for phase, v in led.items():
            o = out.setdefault(phase, {"episodes": 0, "steps": 0, "by_cause": {c: 0 for c in CAUSES}})
            o["episodes"] += v["episodes"]; o["steps"] += v["steps"]
            for c, n in v["by_cause"].items():
                o["by_cause"][c] = o["by_cause"].get(c, 0) + n
    for v in out.values():
        v["mean_steps_per_episode"] = round(v["steps"] / v["episodes"], 1) if v["episodes"] else None
    return out


@flow(name="rally-v8-superar-al-maestro", log_prints=True, persist_result=False)
def rally_v8_pipeline(config_path=str(DEFAULT_CONFIG), timesteps=None, seeds=None, skip_tracking=False, train_only=False):
    config = load_config(config_path)
    if timesteps:
        config["training"]["ppo"]["total_timesteps"] = timesteps
        config["training"]["ppo"]["min_timesteps"] = min(config["training"]["ppo"]["min_timesteps"], timesteps)
    if seeds:
        config["training"]["seeds"] = seeds
    config = load_config(config)
    suite_id = f"rally-v8-{uuid.uuid4().hex}"
    output_root = ROOT / ".prueba-sin-tracking" if skip_tracking else ROOT
    layouts = evaluation_layouts(config)
    print(f"Suite fija: {len(layouts)} pistas (semillas {layouts[0]['seed']}…{layouts[-1]['seed']})")

    if train_only:   # solo entrena y guarda (para correr una semilla a la vez); el informe se arma en la corrida completa
        for seed in config["training"]["seeds"]:
            ppo_task(config, seed, output_root)
        return None
    results = []
    for seed in config["training"]["seeds"]:
        res = ppo_task(config, seed, output_root)
        res["evaluations"] = eval_task(res["policy_factory"], config, layouts, seed, keep=(0, 1, 2))
        res["imitation_evaluation"] = evaluate_v8(res["imitation_policy_factory"], config, layouts, seed=seed)["summary"]
        res["manifest"] = package(res, config, res["evaluations"])
        n, ep = res["evaluations"]["normal"]["summary"], res["episodes"]["total"]
        print(f"PPO semilla {seed}: {ep['episodes']} episodios, {ep['steps']} pasos · limpias {n['clean_rate']:.0%} · completas {n['success_rate']:.0%} · "
              f"lluvia {res['evaluations']['lluvia']['summary']['success_rate']:.0%} · ruido {res['evaluations']['sensor_ruidoso']['summary']['success_rate']:.0%} "
              f"(solo imitación: {res['imitation_evaluation']['success_rate']:.0%})")
        results.append(res)

    rng = np.random.default_rng(0)
    baselines = {"aleatoria": evaluate_v8(lambda e: random_policy(e, rng), config, layouts),
                 "reglas": evaluate_v8(rule_policy, config, layouts, keep=(0, 1, 2)),
                 "reglas_lluvia": evaluate_v8(rule_policy, config, layouts, perturbation="lluvia")}
    n7_factory = packaged_policy_factory(N7_MODEL) if (N7_MODEL / "model.zip").exists() else None
    if n7_factory:
        baselines["ppo_n7"] = evaluate_v8(n7_factory, config, layouts, keep=(0, 1, 2))
        baselines["ppo_n7_lluvia"] = evaluate_v8(n7_factory, config, layouts, perturbation="lluvia")
        baselines["ppo_n7_ruido"] = evaluate_v8(n7_factory, config, layouts, perturbation="sensor_ruidoso")

    summary = {"ppo": {c: mean_summary([r["evaluations"][c]["summary"] for r in results]) for c in ("normal", "lluvia", "sensor_ruidoso")}}
    by_seed = {m: [r["evaluations"]["normal"]["summary"][m] for r in results] for m in ("success_rate", "clean_rate", "mean_time_s_success", "mean_accidents")}

    def validation_key(r):
        pts = [p for p in r["eval_curve"] if p["timesteps"] == r["chosen_checkpoint"]["timesteps"]]
        p = pts[-1]
        return (p["validation_clean_rate"], p["validation_success_rate"], -(p["validation_time_s"] or 1e9))
    best = max(results, key=validation_key)
    rules, ppo = baselines["reglas"]["summary"], summary["ppo"]["normal"]
    crit, n7 = config["experiment"]["selection_criteria"], config["experiment"]["n7_reference"]
    checks = {"mas_vueltas_limpias_que_el_maestro": bool(ppo["clean_rate"] >= crit["min_clean_rate_ppo"]),
              "mas_rapido_que_el_maestro": bool(ppo["mean_time_s_success"] is not None and ppo["mean_time_s_success"] <= crit["max_lap_time_s_ppo"]),
              "aguanta_la_lluvia": bool(summary["ppo"]["lluvia"]["success_rate"] >= crit["min_success_rate_rain_ppo"])}
    im = [r["imitation_evaluation"] for r in results]
    totals = add_ledgers([{k: v for k, v in r["episodes"].items() if k != "total"} for r in results])
    selection = {"criteria": crit, "checks": checks, "accepted": all(checks.values()), "attempt": config["experiment"].get("attempt", 1),
                 "previous_attempts": config["experiment"].get("previous_attempts"), "n7_reference": n7,
                 "recommended_run_id": best["run_id"], "recommended_seed": best["seed"], "recommended_by": "validación",
                 "by_seed": by_seed,
                 "rules": {k: rules[k] for k in ("success_rate", "clean_rate", "mean_time_s_success", "mean_accidents")},
                 "imitation_only": {"success_rate": float(np.mean([i["success_rate"] for i in im])), "clean_rate": float(np.mean([i["clean_rate"] for i in im])),
                                    "mean_accidents": float(np.mean([i["mean_accidents"] for i in im])),
                                    "mean_time_s_success": float(np.mean([i["mean_time_s_success"] for i in im if i["mean_time_s_success"]])) if any(i["mean_time_s_success"] for i in im) else None,
                                    "by_seed": [i["success_rate"] for i in im]}}
    training_totals = {"by_phase": totals, "episodes": sum(v["episodes"] for v in totals.values()), "steps": sum(v["steps"] for v in totals.values()),
                       "by_cause": {c: sum(v["by_cause"].get(c, 0) for v in totals.values()) for c in CAUSES},
                       "models": len(results), "budget_steps_ppo": config["training"]["ppo"]["total_timesteps"] * len(results),
                       "steps_saved_by_early_stopping": sum(r["early_stopping"]["steps_saved"] for r in results),
                       "early_stopped_runs": sum(r["early_stopping"]["stopped_early"] for r in results),
                       "train_seconds": round(sum(r["train_seconds"] for r in results), 1)}
    prev_report = config["experiment"].get("continues_report")
    if prev_report:   # intento de continuación: el libro de episodios suma lo que ya se había entrenado en el intento anterior
        before = json.loads((ROOT / prev_report).read_text(encoding="utf-8"))["training_totals"]
        this_attempt = {k: training_totals[k] for k in ("episodes", "steps", "steps_saved_by_early_stopping", "early_stopped_runs", "train_seconds", "budget_steps_ppo")}
        for phase, v in before["by_phase"].items():
            mine = totals.setdefault(phase, {"episodes": 0, "steps": 0, "by_cause": {c: 0 for c in CAUSES}})
            mine["episodes"] += v["episodes"]; mine["steps"] += v["steps"]
            mine["by_cause"] = {c: mine["by_cause"].get(c, 0) + v["by_cause"].get(c, 0) for c in CAUSES}
            mine["mean_steps_per_episode"] = round(mine["steps"] / max(1, mine["episodes"]), 1)
        training_totals.update(by_phase=totals, episodes=sum(v["episodes"] for v in totals.values()), steps=sum(v["steps"] for v in totals.values()),
                               by_cause={c: sum(v["by_cause"].get(c, 0) for v in totals.values()) for c in CAUSES},
                               models=len(results) + before["models"], train_seconds=round(training_totals["train_seconds"] + before["train_seconds"], 1),
                               this_attempt=this_attempt, previous_attempt={k: before[k] for k in ("episodes", "steps", "models", "train_seconds")})

    data_dir = output_root / "data" / "experiments" / suite_id
    write_json(data_dir / "escenarios_evaluacion.json", {"suite": "rally-v7-suite-1", "layouts": layouts})
    all_evals = {f"ppo_seed{r['seed']}_{c}": ev for r in results for c, ev in r["evaluations"].items()}
    all_evals.update({f"baseline_{k}": v for k, v in baselines.items()})
    write_eval_csv(data_dir / "resultados_por_caso.csv", all_evals)
    write_json(data_dir / "episodios_de_entrenamiento.json", {"por_semilla": {str(r["seed"]): r["episodes"] for r in results}, "total": training_totals})
    dvc_pointers = None
    if not skip_tracking:
        dvc_pointers = dvc_task(data_dir)
        for r in results:
            r["mlflow_run_id"] = mlflow_task(r, r["manifest"], config, "recomendado" if r is best else "ppo", register=r is best)
    for r in results:
        r.setdefault("mlflow_run_id", None)

    report = {"suite_id": suite_id, "environment_version": "rally-v8", "reward_version": config["reward_version"], "level_id": "N8",
              "tracking": "omitido (--skip-tracking): sin DVC ni MLflow, no es corrida oficial" if skip_tracking else "DVC + MLflow",
              "config": config, "selection": selection, "summary": summary, "training_totals": training_totals,
              "baselines": {k: v["summary"] for k, v in baselines.items()}, "dvc_pointers": dvc_pointers,
              "runs": [{"algorithm": "ppo", "seed": r["seed"], "run_id": r["run_id"], "mlflow_run_id": r["mlflow_run_id"], "manifest": r["manifest"],
                        "evaluation": {c: ev["summary"] for c, ev in r["evaluations"].items()}, "chosen_checkpoint": r["chosen_checkpoint"],
                        "imitation": r["imitation"], "imitation_evaluation": r["imitation_evaluation"], "early_stopping": r["early_stopping"],
                        "episodes": r["episodes"], "timesteps": r["timesteps"], "ppo_timesteps": r["ppo_timesteps"], "train_seconds": round(r["train_seconds"], 1),
                        "curves": {"entrenamiento": r["train_curve"], "evaluacion": r["eval_curve"]}} for r in results]}
    write_json(ROOT / "reports" / f"{suite_id}.json", report)

    # ---------- archivo de la web: reproducciones reales (Python decide; la web solo dibuja) ----------
    track = Track(config["track"]["straight_m"], config["track"]["radius_m"])
    samples = [[round(v, 3) for v in track.center(s)] for s in np.arange(0, track.length, 2.0)]
    rep = best["evaluations"]
    scenarios = []
    for i in (0, 1, 2):
        scenarios.append({"id": f"alumno-maestro-{i}", "label": f"PPO del N8 y el maestro (reglas) · pista nueva #{i + 1}", "mode": "compare",
                          "policy": "PPO N8", "layout": layouts[i], "frames": rep["normal"]["replays"][i]["frames"],
                          "ghost": {"policy": "Reglas · el maestro", "frames": baselines["reglas"]["replays"][i]["frames"]}})
    if n7_factory:
        for i in (0, 1, 2):
            scenarios.append({"id": f"n7-n8-{i}", "label": f"PPO del N8 y PPO del N7 · pista nueva #{i + 1}", "mode": "compare",
                              "policy": "PPO N8", "layout": layouts[i], "frames": rep["normal"]["replays"][i]["frames"],
                              "ghost": {"policy": "PPO N7", "frames": baselines["ppo_n7"]["replays"][i]["frames"]}})
    scenarios.append({"id": "ppo-lluvia", "label": "PPO del N8 con lluvia (menos agarre) · pista nueva #1", "mode": "incident", "policy": "PPO N8 · lluvia",
                      "layout": layouts[0], "frames": rep["lluvia"]["replays"][0]["frames"]})
    scenarios.append({"id": "ppo-ruido", "label": "PPO del N8 con sensores con ruido · pista nueva #1", "mode": "incident", "policy": "PPO N8 · ruido",
                      "layout": layouts[0], "frames": rep["sensor_ruidoso"]["replays"][0]["frames"]})
    scenarios.append({"id": "reglas-0", "label": "Solo el maestro (reglas) · pista nueva #1", "mode": "baseline", "policy": "Reglas", "layout": layouts[0],
                      "frames": baselines["reglas"]["replays"][0]["frames"]})
    web = {k: report[k] for k in ("suite_id", "environment_version", "reward_version", "level_id", "tracking", "selection", "summary", "training_totals", "baselines")}
    web.update({"config": {k: config[k] for k in ("experiment", "track", "physics", "terrains", "reward", "episode", "perturbations", "training", "sensors")},
                "track_samples": samples, "track_length": track.length, "scenarios": scenarios,
                "runs": [{k: v for k, v in run.items() if k != "manifest"} | {"model_sha256": run["manifest"]["model_sha256"]} for run in report["runs"]]})
    write_json(ROOT / "rally-dashboard" / "dist" / "v8-results.json", web)
    t = ppo["mean_time_s_success"]
    print(f"Informe: reports/{suite_id}.json | {training_totals['episodes']} episodios, {training_totals['steps']} pasos | PPO limpias {ppo['clean_rate']:.0%} "
          f"(maestro {rules['clean_rate']:.0%}) · completas {ppo['success_rate']:.0%} · vuelta {t:.1f} s (maestro {rules['mean_time_s_success']:.1f} s) · "
          f"lluvia {summary['ppo']['lluvia']['success_rate']:.0%} | {'ACEPTADO' if selection['accepted'] else 'RECHAZADO'}")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Pipeline Rally v8 (N8): superar al maestro")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--timesteps", type=int, help="Presupuesto de pasos de PPO por modelo (prueba rápida)")
    parser.add_argument("--seeds", nargs="+", type=int)
    parser.add_argument("--skip-tracking", action="store_true", help="No usa DVC ni MLflow")
    parser.add_argument("--train-only", action="store_true", help="Solo entrena las semillas indicadas y las deja guardadas")
    args = parser.parse_args()
    rally_v8_pipeline(args.config, args.timesteps, args.seeds, args.skip_tracking, args.train_only)
