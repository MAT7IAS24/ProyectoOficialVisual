"""Q-learning, referencias (aleatoria y de reglas) y evaluación del nivel N3.

No modifica nada de v1 ni v2. La política de reglas solo usa la observación,
igual que el agente: así la comparación es justa.
"""
from __future__ import annotations

import csv
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import uuid

import numpy as np

from race_env_v3 import RallyV3Env, load_config

ROOT = Path(__file__).resolve().parent
SOURCE_FILES = ("race_env_v3.py", "training_v3.py", "pipeline_v3.py", "environments.py", "configs/rally-v3.json")
EVALUATION_SUITE_ID = "rally-v3-suite-1"


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def epsilon_at(episode, config):
    t = config["training"]
    fraction = (episode - 1) / max(1, t["episodes"] - 1)
    return t["epsilon_start"] + fraction * (t["epsilon_end"] - t["epsilon_start"])


def update_q(q, state, action, reward, next_state, terminated, config):
    """Un truncamiento externo conserva bootstrap; una terminación no."""
    t = config["training"]
    target = reward if terminated else reward + t["gamma"] * float(q[next_state].max())
    td_error = target - q[state, action]
    q[state, action] += t["alpha"] * td_error
    return float(td_error)


# ---- políticas de referencia -------------------------------------------------
def random_policy(env, rng):
    def act(obs):
        return int(rng.integers(env.action_space.n))
    return act


def rule_policy(env):
    """Reglas a mano: crucero a velocidad 2, frena ante lodo/agua/terreno suelto,
    esquiva foso y barril cambiando de carril, y toma las rampas a toda velocidad."""
    lanes = env.lane_count

    def act(obs):
        _, speed, _, lane, layer, ahead = obs
        name = "meta" if ahead == env.meta_id else env.terrain_by_id[ahead]["name"]
        if name in ("foso", "barril") and layer == 0:
            if speed > env.e["lane_change_max_speed"]:
                return 0
            return 4 if lane < lanes - 1 else 3
        if name in ("rampa", "rampa_con_barril"):
            return 2 if speed < env.e["max_speed_level"] else 1
        if name == "lodo":
            return 0 if speed > 1 else 1
        if name in ("agua", "sin_pista"):
            return 0 if speed > 2 else 1
        return 2 if speed < 2 else 1
    return act


def q_policy(env, q):
    def act(obs):
        return int(np.argmax(q[env.encode(obs)]))
    return act


def evaluate_policy(policy_factory, config, seed, perturbation=None, keep_replays=3, q=None):
    """Evalúa una política congelada con la suite fija (mismas semillas para todas)."""
    env = RallyV3Env(config, perturbation)
    t = config["training"]
    policy = policy_factory(env)
    episodes, replays = [], []
    for index in range(t["evaluation_episodes"]):
        obs, info = env.reset(seed=seed + t["evaluation_seed_offset"] + index)
        total = 0.0
        qv = (lambda o: q[env.encode(o)].tolist()) if q is not None else (lambda o: None)
        frames = [{**info, "reward": 0, "return": 0, "action": None, "observation": list(obs), "q_values": qv(obs)}]
        while True:
            action = policy(obs)
            next_obs, reward, terminated, truncated, info = env.step(action)
            total += reward
            frames.append({**info, "reward": reward, "return": total, "action": action, "observation": list(next_obs), "decision_observation": list(obs), "q_values": qv(obs)})
            obs = next_obs
            if terminated or truncated:
                episodes.append({"episode": index + 1, "return": total, "steps": info["steps"], "fuel": info["fuel"], "accidents": info["accidents"], "start_lane": frames[0]["lane"], "termination_cause": info["termination_cause"], "success": info["termination_cause"] == "vuelta_completada"})
                break
        if index < keep_replays:
            replays.append({"episode": index + 1, "frames": frames})
    env.close()
    summary = {"success_rate": float(np.mean([r["success"] for r in episodes])),
               **{f"mean_{key}": float(np.mean([r[key] for r in episodes])) for key in ("return", "steps", "fuel", "accidents")}}
    return {"summary": summary, "episodes": episodes, "replays": replays}


def evaluate_saved_model(model_dir, config, seed, perturbation=None, keep_replays=1):
    """Carga una tabla Q guardada y la evalúa (sirve para comparar condiciones)."""
    q = np.load(Path(model_dir) / "q_table.npy", allow_pickle=False)
    return evaluate_policy(lambda env: q_policy(env, q), config, seed, perturbation=perturbation, q=q, keep_replays=keep_replays)


def evaluate_baselines(config, seed):
    out = {}
    rng = np.random.default_rng(seed)
    out["aleatoria"] = evaluate_policy(lambda env: random_policy(env, rng), config, seed, keep_replays=0)
    out["reglas"] = evaluate_policy(rule_policy, config, seed, keep_replays=1)
    return out


TRAINING_CONDITIONS = {
    "normal": {"perturbation": None, "mix_probability": 0.0},
    "solo_lluvia": {"perturbation": "lluvia", "mix_probability": 0.0},
    "clima_mixto": {"perturbation": None, "mix_probability": 0.5},
}


def train_seed(config, seed, output_root=ROOT, condition="normal", parent_run_id=None):
    """Entrena una semilla desde cero.

    condition:
      normal      -> siempre pista normal (candidato principal)
      solo_lluvia -> siempre con lluvia (intervención A)
      clima_mixto -> cada episodio llueve con probabilidad 0.5 (intervención B)
    La evaluación SIEMPRE usa la misma suite en las dos condiciones (normal y lluvia),
    así los modelos se pueden comparar entre sí. parent_run_id = modelo que se intenta recuperar.
    """
    if condition not in TRAINING_CONDITIONS:
        raise ValueError(f"Condición desconocida: {condition}")
    cond = TRAINING_CONDITIONS[condition]
    base = load_config(config)
    base["training"]["seed"] = seed
    config = load_config(base, cond["perturbation"]) if cond["perturbation"] else deepcopy(base)
    config["training_conditions"] = {"name": condition, **cond}
    t = config["training"]
    root = Path(output_root)
    run_id = f"rally-v3-{uuid.uuid4().hex}"
    folder = root / "models" / run_id
    dataset = root / "data" / "experiments" / run_id / "transitions.csv"
    folder.mkdir(parents=True, exist_ok=False)
    dataset.parent.mkdir(parents=True, exist_ok=False)
    rng = np.random.default_rng(seed)
    weather_rng = np.random.default_rng([seed, 2026])  # aparte: no cambia la exploración
    env_normal = RallyV3Env(config)
    env_rain = RallyV3Env(base, "lluvia") if cond["mix_probability"] > 0 else None
    q = np.zeros((int(np.prod(env_normal.state_shape)), env_normal.action_space.n), dtype=np.float64)
    metrics, replays = [], []
    header = ["episode", "weather", "step", "state", "observation", "action", "next_state", "next_observation", "reward", "terminated", "truncated", "termination_cause", "fuel", "speed_level", "segment", "lane", "layer", "accidents", "epsilon", "q_before", "q_after", "td_error", "episode_return", "events", "reward_components"]
    with dataset.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=header)
        writer.writeheader()
        for episode in range(1, t["episodes"] + 1):
            rainy = env_rain is not None and weather_rng.random() < cond["mix_probability"]
            env = env_rain if rainy else env_normal
            weather = "lluvia" if rainy or cond["perturbation"] == "lluvia" else "normal"
            epsilon = epsilon_at(episode, config)
            obs, info = env.reset(seed=seed + episode)
            total, errors = 0.0, []
            keep = episode <= 3 or episode > t["episodes"] - 3
            frames = [{**info, "reward": 0, "return": 0, "action": None, "observation": list(obs), "q_values": q[env.encode(obs)].tolist()}] if keep else None
            while True:
                state = env.encode(obs)
                if rng.random() < epsilon:
                    action = int(rng.integers(env.action_space.n))
                else:
                    action = int(rng.choice(np.flatnonzero(q[state] == q[state].max())))
                next_obs, reward, terminated, truncated, info = env.step(action)
                next_state = env.encode(next_obs)
                before = float(q[state, action])
                td = update_q(q, state, action, reward, next_state, terminated, config)
                errors.append(abs(td))
                total += reward
                writer.writerow({"episode": episode, "weather": weather, "step": info["steps"], "state": state, "observation": json.dumps(obs), "action": action, "next_state": next_state, "next_observation": json.dumps(next_obs), "reward": reward, "terminated": terminated, "truncated": truncated, "termination_cause": info["termination_cause"], "fuel": info["fuel"], "speed_level": info["speed_level"], "segment": info["segment"], "lane": info["lane"], "layer": info["layer"], "accidents": info["accidents"], "epsilon": epsilon, "q_before": before, "q_after": float(q[state, action]), "td_error": td, "episode_return": total, "events": json.dumps(info["events"]), "reward_components": json.dumps(info["reward_components"], sort_keys=True)})
                if keep:
                    frames.append({**info, "reward": reward, "return": total, "action": action, "observation": list(next_obs), "decision_observation": list(obs), "q_values": q[state].tolist()})
                obs = next_obs
                if terminated or truncated:
                    break
            metrics.append({"episode": episode, "rain": int(weather == "lluvia"), "return": total, "steps": info["steps"], "success": int(info["termination_cause"] == "vuelta_completada"), "fuel": info["fuel"], "accidents": info["accidents"], "epsilon": epsilon, "mean_abs_td_error": float(np.mean(errors)), "q_min": float(q.min()), "q_max": float(q.max())})
            if keep:
                replays.append({"episode": episode, "weather": weather, "frames": frames})
    evaluation = evaluate_policy(lambda e: q_policy(e, q), base, seed, q=q)
    evaluation_rain = evaluate_policy(lambda e: q_policy(e, q), base, seed, perturbation="lluvia", q=q, keep_replays=1)
    baselines = evaluate_baselines(base, seed)
    np.save(folder / "q_table.npy", q, allow_pickle=False)
    write_json(folder / "config.json", config)
    write_json(folder / "training_metrics.json", metrics)
    write_json(folder / "evaluation.json", {"suite": EVALUATION_SUITE_ID, "normal": evaluation, "lluvia": evaluation_rain, "baselines": {k: v["summary"] for k, v in baselines.items()}})
    revision = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    sources = {name: digest(ROOT / name) for name in SOURCE_FILES if (ROOT / name).exists()}
    metadata = {"experiment_id": run_id, "level_id": config["level_id"], "training_condition": condition, "parent_run_id": parent_run_id, "environment_version": config["environment_version"], "reward_version": config["reward_version"], "algorithm": "tabular_q_learning", "seed": seed, "episodes": t["episodes"], "state_shape": env_normal.state_shape, "q_shape": q.shape, "observation_fields": ["tramo", "nivel_velocidad", "balde_combustible", "carril", "capa", "terreno_adelante"], "actions": config["environment"]["actions"], "state_encoding": "numpy.ravel_multi_index(obs, state_shape), orden C", "config_sha256": digest(folder / "config.json"), "dataset_sha256": digest(dataset), "model_sha256": digest(folder / "q_table.npy"), "source_git_head": revision, "source_sha256": sources, "evaluation_suite_id": EVALUATION_SUITE_ID, "evaluation": evaluation["summary"], "evaluation_lluvia": evaluation_rain["summary"], "baselines": {k: v["summary"] for k, v in baselines.items()}, "training_success_rate": float(np.mean([m["success"] for m in metrics])), "last_window_success_rate": float(np.mean([m["success"] for m in metrics[-t["summary_window"]:]]))}
    write_json(folder / "metadata.json", metadata)
    manifest = {"run_id": run_id, "level_id": config["level_id"], "environment_version": config["environment_version"], "git_commit": revision, "config_sha256": metadata["config_sha256"], "model_uri": f"models/{run_id}/q_table.npy", "model_sha256": metadata["model_sha256"], "dataset_sha256": metadata["dataset_sha256"], "normalization_uri": None, "normalization_note": "Observaciones discretas: no hay escalado; el índice se calcula con state_encoding de metadata.json.", "runtime_ref": "requirements.txt + race_env_v3.py en el commit indicado", "evaluation_suite_id": EVALUATION_SUITE_ID, "seed": seed, "parent_run_id": parent_run_id, "training_origin": "desde_cero", "training_condition": condition}
    write_json(folder / "manifest.json", manifest)
    (folder / "README.md").write_text("---\ntags:\n- reinforcement-learning\n- q-learning\n- gymnasium\n---\n\n# Rally v3 / N3\n\nTabla Q tabular con 5 acciones: frenar, mantener, acelerar, carril izquierda y carril derecha. Cargar con `numpy.load('q_table.npy', allow_pickle=False)`; indexar con `numpy.ravel_multi_index(obs, metadata['state_shape'])`. Observación: (tramo, nivel de velocidad, balde de combustible, carril, capa suelo/puente, terreno adelante). Condición de entrenamiento en metadata.json (`training_condition`). La configuración exacta está en config.json; el manifiesto en manifest.json. La observación omite el contador de accidentes: es parcialmente observable. El carril de salida es aleatorio por episodio (semilla controlada).\n", encoding="utf-8")
    env_normal.close()
    return {"experiment_id": run_id, "seed": seed, "condition": condition, "dataset": str(dataset), "model_dir": str(folder), "metadata": metadata, "metrics": metrics, "evaluation": evaluation, "evaluation_lluvia": evaluation_rain, "baselines": baselines, "training_replays": replays, "config": config}
