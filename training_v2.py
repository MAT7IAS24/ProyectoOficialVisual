"""Q-learning y evaluación N2 sin efectos sobre el entrenamiento v1."""
from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path
import subprocess
import uuid

import numpy as np

from race_env_v2 import RallyV2Env, load_config

ROOT = Path(__file__).resolve().parent


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


def evaluate(q, config, seed):
    env = RallyV2Env(config)
    episodes, replay = [], []
    for index in range(config["training"]["evaluation_episodes"]):
        obs, info = env.reset(seed=seed + config["training"]["evaluation_seed_offset"] + index)
        total, frames = 0.0, [{**info, "reward": 0, "return": 0, "action": None, "observation": obs, "q_values": q[env.encode(obs)].tolist()}]
        while True:
            state = env.encode(obs)
            action = int(np.argmax(q[state]))
            next_obs, reward, terminated, truncated, info = env.step(action)
            total += reward
            frames.append({**info, "reward": reward, "return": total, "action": action, "observation": next_obs, "decision_observation": obs, "q_values": q[state].tolist()})
            obs = next_obs
            if terminated or truncated:
                episodes.append({"episode": index + 1, "return": total, "steps": info["steps"], "fuel": info["fuel"], "off_track_count": info["off_track_count"], "termination_cause": info["termination_cause"], "success": info["termination_cause"] == "vuelta_completada"})
                break
        if index == 0:
            replay = frames
    env.close()
    summary = {"success_rate": float(np.mean([r["success"] for r in episodes])), **{f"mean_{key}": float(np.mean([r[key] for r in episodes])) for key in ("return", "steps", "fuel", "off_track_count")}}
    return {"summary": summary, "episodes": episodes, "replay": replay}


def train_seed(config, seed, output_root=ROOT):
    config = load_config(config)
    config["training"]["seed"] = seed
    t = config["training"]
    root = Path(output_root)
    run_id = f"rally-v2-{uuid.uuid4().hex}"
    folder = root / "models" / run_id
    dataset = root / "data" / "experiments" / run_id / "transitions.csv"
    folder.mkdir(parents=True, exist_ok=False)
    dataset.parent.mkdir(parents=True, exist_ok=False)
    rng = np.random.default_rng(seed)
    env = RallyV2Env(config)
    q = np.zeros((int(np.prod(env.state_shape)), env.action_space.n), dtype=np.float64)
    metrics, replays = [], []
    header = ["episode", "step", "state", "observation", "action", "next_state", "next_observation", "reward", "terminated", "truncated", "termination_cause", "fuel", "speed_level", "off_track_count", "position_meters", "epsilon", "q_before", "q_after", "td_error", "episode_return", "reward_components"]
    with dataset.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=header)
        writer.writeheader()
        for episode in range(1, t["episodes"] + 1):
            epsilon = epsilon_at(episode, config)
            obs, info = env.reset(seed=seed + episode)
            total, errors = 0.0, []
            frames = [{**info, "reward": 0, "return": 0, "action": None, "observation": obs, "q_values": q[env.encode(obs)].tolist()}]
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
                writer.writerow({"episode": episode, "step": info["steps"], "state": state, "observation": json.dumps(obs), "action": action, "next_state": next_state, "next_observation": json.dumps(next_obs), "reward": reward, "terminated": terminated, "truncated": truncated, "termination_cause": info["termination_cause"], "fuel": info["fuel"], "speed_level": info["speed_level"], "off_track_count": info["off_track_count"], "position_meters": info["position_meters"], "epsilon": epsilon, "q_before": before, "q_after": float(q[state, action]), "td_error": td, "episode_return": total, "reward_components": json.dumps(info["reward_components"], sort_keys=True)})
                frames.append({**info, "reward": reward, "return": total, "action": action, "observation": next_obs, "decision_observation": obs, "q_values": q[state].tolist()})
                obs = next_obs
                if terminated or truncated:
                    break
            metrics.append({"episode": episode, "return": total, "steps": info["steps"], "success": int(info["termination_cause"] == "vuelta_completada"), "fuel": info["fuel"], "off_track_count": info["off_track_count"], "termination_cause": info["termination_cause"], "epsilon": epsilon, "mean_abs_td_error": float(np.mean(errors)), "q_min": float(q.min()), "q_max": float(q.max())})
            if episode <= 3 or episode > t["episodes"] - 3:
                replays.append({"episode": episode, "frames": frames})
    evaluation = evaluate(q, config, seed)
    np.save(folder / "q_table.npy", q, allow_pickle=False)
    write_json(folder / "config.json", config)
    write_json(folder / "training_metrics.json", metrics)
    write_json(folder / "evaluation.json", evaluation)
    revision = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True)
    metadata = {"experiment_id": run_id, "environment_version": config["environment_version"], "reward_version": config["reward_version"], "algorithm": "tabular_q_learning", "seed": seed, "episodes": t["episodes"], "state_shape": env.state_shape, "q_shape": q.shape, "actions": config["environment"]["actions"], "state_encoding": "numpy.ravel_multi_index(obs, state_shape), orden C", "config_sha256": digest(folder / "config.json"), "dataset_sha256": digest(dataset), "model_sha256": digest(folder / "q_table.npy"), "source_git_head": revision.stdout.strip(), "source_sha256": {name: digest(ROOT / name) for name in ("race_env_v2.py", "training_v2.py", "pipeline_v2.py", "environments.py")}, "evaluation": evaluation["summary"], "training_success_rate": float(np.mean([m["success"] for m in metrics])), "last_window_success_rate": float(np.mean([m["success"] for m in metrics[-t["summary_window"]:]]))}
    write_json(folder / "metadata.json", metadata)
    (folder / "README.md").write_text("---\ntags:\n- reinforcement-learning\n- q-learning\n- gymnasium\n---\n\n# Rally v2 / N2\n\nTabla Q tabular con acciones frenar, mantener y acelerar. Cargar con `numpy.load('q_table.npy', allow_pickle=False)`; indexar con `numpy.ravel_multi_index(obs, metadata['state_shape'])`. La configuración exacta está en config.json; métricas de entrenamiento y evaluación en sus respectivos JSON. La observación omite el historial de premios y el contador de salidas: es parcialmente observable. Las curvas y su adherencia son deterministas; la varianza entre semillas procede del entrenamiento.\n", encoding="utf-8")
    env.close()
    return {"experiment_id": run_id, "seed": seed, "dataset": str(dataset), "model_dir": str(folder), "metadata": metadata, "metrics": metrics, "evaluation": evaluation, "training_replays": replays, "config": config}
