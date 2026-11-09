"""Sparse tabular Q-learning, evaluation and reproducible artifacts for N5."""
from __future__ import annotations

import csv
from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import subprocess
import uuid

import numpy as np

from race_env_v5 import DEFAULT_CONFIG, OBSERVATION_FIELDS, RallyV5Env, load_config

ROOT = Path(__file__).resolve().parent
EVALUATION_SUITE_ID = "rally-v5-suite-1"
TRAINING_SOURCES = (
    "race_env_v5.py",
    "training_v5.py",
    "pipeline_v5.py",
    "configs/rally-v5.json",
    "environments.py",
    "run_experiment.py",
)


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            value, indent=2, ensure_ascii=False, allow_nan=False, default=_json_default
        ) + "\n",
        encoding="utf-8",
    )


def _json_default(value):
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, Path):
        return str(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def epsilon_at(episode, config):
    training = config["training"]
    fraction = (episode - 1) / max(1, training["episodes"] - 1)
    return training["epsilon_start"] + fraction * (training["epsilon_end"] - training["epsilon_start"])


def values_for(q, state, action_count):
    return q.get(state, np.zeros(action_count, dtype=np.float64))


def update_q(q, state, action, reward, next_state, terminated, truncated, config, action_count):
    training = config["training"]
    current = values_for(q, state, action_count)
    next_values = values_for(q, next_state, action_count)
    target = reward if terminated or truncated else reward + training["gamma"] * float(next_values.max())
    td_error = target - current[action]
    updated = current.copy()
    updated[action] += training["alpha"] * td_error
    q[state] = updated
    return float(td_error)


def random_policy(env, rng):
    return lambda obs: int(rng.integers(env.action_space.n))


def rule_policy(env):
    def act(obs):
        _, speed, _, lane, layer, ahead = obs[:6]
        name = "meta" if ahead == env.meta_id else env.terrain_by_id[ahead]["name"]
        if name in ("foso", "barril", "rampa_con_barril") and layer == 0:
            if speed > env.e["lane_change_max_speed"]:
                return 0
            return 4 if lane < env.lane_count - 1 else 3
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
        return int(np.argmax(values_for(q, env.encode(obs), env.action_space.n)))
    return act


def evaluate_policy(policy_factory, config, seed, perturbation=None, keep_replays=2, q=None):
    env = RallyV5Env(config, perturbation)
    training = config["training"]
    policy = policy_factory(env)
    episodes, replays = [], []
    for index in range(training["evaluation_episodes"]):
        obs, info = env.reset(seed=seed + training["evaluation_seed_offset"] + index)
        total = 0.0
        qv = lambda observation: (
            values_for(q, env.encode(observation), env.action_space.n).tolist() if q is not None else None
        )
        frames = [
            {**info, "reward": 0.0, "return": 0.0, "action": None,
             "observation": list(obs), "q_values": qv(obs)}
        ]
        while True:
            action = policy(obs)
            next_obs, reward, terminated, truncated, info = env.step(action)
            total += reward
            frames.append({
                **info, "reward": float(reward), "return": total, "action": action,
                "observation": list(next_obs), "decision_observation": list(obs),
                "q_values": qv(obs),
            })
            obs = next_obs
            if terminated or truncated:
                episodes.append({
                    "episode": index + 1,
                    "return": total,
                    "steps": info["steps"],
                    "fuel": info["fuel"],
                    "accidents": info["accidents"],
                    "start_lane": frames[0]["lane"],
                    "termination_cause": info["termination_cause"],
                    "success": info["termination_cause"] == "vuelta_completada",
                })
                break
        if index < keep_replays:
            replays.append({"episode": index + 1, "frames": frames})
    env.close()
    summary = {
        "success_rate": float(np.mean([item["success"] for item in episodes])),
        **{
            f"mean_{key}": float(np.mean([item[key] for item in episodes]))
            for key in ("return", "steps", "fuel", "accidents")
        },
    }
    return {"summary": summary, "episodes": episodes, "replays": replays}


def evaluate_baselines(config, seed, perturbation=None):
    return {
        "aleatoria": evaluate_policy(
            lambda env: random_policy(env, np.random.default_rng(seed)),
            config,
            seed,
            perturbation=perturbation,
            keep_replays=0,
        ),
        "reglas": evaluate_policy(
            rule_policy, config, seed, perturbation=perturbation, keep_replays=1
        ),
    }


def train_seed(config=DEFAULT_CONFIG, seed=None, output_root=ROOT):
    config = load_config(config)
    config = deepcopy(config)
    seed = config["training"]["seed"] if seed is None else seed
    if type(seed) is not int or seed < 0:
        raise ValueError("La semilla debe ser un entero no negativo")
    config["training"]["seed"] = seed
    training = config["training"]
    output_root = Path(output_root)
    run_id = f"rally-v5-{uuid.uuid4().hex}"
    model_dir = output_root / "models" / run_id
    dataset = output_root / "data" / "experiments" / run_id / "transitions.csv"
    model_dir.mkdir(parents=True, exist_ok=False)
    dataset.parent.mkdir(parents=True, exist_ok=False)

    env_normal = RallyV5Env(config)
    env_rain = RallyV5Env(config, "lluvia")
    action_count = env_normal.action_space.n
    q = {}
    rng = np.random.default_rng(seed)
    weather_rng = np.random.default_rng([seed, 2026])
    metrics, replays = [], []
    columns = [
        "episode", "weather", "step", "state", "observation", "action",
        "next_state", "next_observation", "reward", "terminated", "truncated",
        "termination_cause", "fuel", "speed_level", "segment", "lane", "layer",
        "accidents", "best_segment", "epsilon", "q_before", "q_after",
        "td_error", "episode_return", "events", "gap_crossings", "reward_components",
    ]
    with dataset.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=columns)
        writer.writeheader()
        for episode in range(1, training["episodes"] + 1):
            rainy = weather_rng.random() < training["weather_mix_probability"]
            env = env_rain if rainy else env_normal
            epsilon = epsilon_at(episode, config)
            obs, _ = env.reset(seed=seed + episode)
            total, errors = 0.0, []
            keep = episode <= 3 or episode > training["episodes"] - 3
            frames = []
            if keep:
                initial_info = env._info()
                frames.append({
                    **initial_info, "reward": 0.0, "return": 0.0, "action": None,
                    "observation": list(obs),
                    "q_values": values_for(q, env.encode(obs), action_count).tolist(),
                })
            while True:
                state = env.encode(obs)
                state_values = values_for(q, state, action_count)
                if rng.random() < epsilon:
                    action = int(rng.integers(action_count))
                else:
                    best = np.flatnonzero(state_values == state_values.max())
                    action = int(rng.choice(best))
                next_obs, reward, terminated, truncated, info = env.step(action)
                next_state = env.encode(next_obs)
                before = float(values_for(q, state, action_count)[action])
                td_error = update_q(
                    q, state, action, reward, next_state, terminated, truncated,
                    config, action_count,
                )
                errors.append(abs(td_error))
                total += reward
                writer.writerow({
                    "episode": episode,
                    "weather": info["weather"],
                    "step": info["steps"],
                    "state": state,
                    "observation": json.dumps(obs),
                    "action": action,
                    "next_state": next_state,
                    "next_observation": json.dumps(next_obs),
                    "reward": reward,
                    "terminated": terminated,
                    "truncated": truncated,
                    "termination_cause": info["termination_cause"],
                    "fuel": info["fuel"],
                    "speed_level": info["speed_level"],
                    "segment": info["segment"],
                    "lane": info["lane"],
                    "layer": info["layer"],
                    "accidents": info["accidents"],
                    "best_segment": info["best_segment"],
                    "epsilon": epsilon,
                    "q_before": before,
                    "q_after": float(values_for(q, state, action_count)[action]),
                    "td_error": td_error,
                    "episode_return": total,
                    "events": json.dumps(info["events"], ensure_ascii=False),
                    "gap_crossings": json.dumps(info["gap_crossings"], ensure_ascii=False),
                    "reward_components": json.dumps(
                        info["reward_components"], sort_keys=True, ensure_ascii=False
                    ),
                })
                if keep:
                    frames.append({
                        **info, "reward": float(reward), "return": total, "action": action,
                        "observation": list(next_obs), "decision_observation": list(obs),
                        "q_values": values_for(q, state, action_count).tolist(),
                    })
                obs = next_obs
                if terminated or truncated:
                    break
            metrics.append({
                "episode": episode,
                "weather": "lluvia" if rainy else "normal",
                "rain": int(rainy),
                "return": float(total),
                "steps": info["steps"],
                "success": int(info["termination_cause"] == "vuelta_completada"),
                "fuel": info["fuel"],
                "accidents": info["accidents"],
                "epsilon": float(epsilon),
                "mean_abs_td_error": float(np.mean(errors)),
                "visited_states": len(q),
            })
            if keep:
                replays.append({
                    "episode": episode, "weather": "lluvia" if rainy else "normal",
                    "frames": frames,
                })

    evaluation = evaluate_policy(
        lambda env: q_policy(env, q), config, seed, q=q
    )
    evaluation_rain = evaluate_policy(
        lambda env: q_policy(env, q), config, seed, perturbation="lluvia", q=q
    )
    baselines = {
        "normal": evaluate_baselines(config, seed),
        "lluvia": evaluate_baselines(config, seed, perturbation="lluvia"),
    }
    ordered_states = sorted(q)
    np.savez_compressed(
        model_dir / "q_table.npz",
        state_ids=np.asarray(ordered_states, dtype=np.int64),
        values=np.asarray([q[state] for state in ordered_states], dtype=np.float64),
    )
    write_json(model_dir / "config.json", config)
    write_json(model_dir / "training_metrics.json", metrics)
    write_json(model_dir / "evaluation.json", {
        "suite": EVALUATION_SUITE_ID,
        "normal": evaluation,
        "lluvia": evaluation_rain,
        "baselines": {
            weather: {name: result["summary"] for name, result in group.items()}
            for weather, group in baselines.items()
        },
    })
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.strip()
    source_hashes = {
        name: digest(ROOT / name) for name in TRAINING_SOURCES if (ROOT / name).is_file()
    }
    metadata = {
        "experiment_id": run_id,
        "level_id": config["level_id"],
        "environment_version": config["environment_version"],
        "reward_version": config["reward_version"],
        "algorithm": "sparse_tabular_q_learning",
        "seed": seed,
        "episodes": training["episodes"],
        "state_shape": env_normal.state_shape,
        "state_count": math.prod(env_normal.state_shape),
        "action_count": action_count,
        "stored_state_count": len(q),
        "observation_fields": list(OBSERVATION_FIELDS),
        "actions": config["environment"]["actions"],
        "state_encoding": "numpy.ravel_multi_index(obs, state_shape), order C; sparse keys in q_table.npz",
        "config_sha256": digest(model_dir / "config.json"),
        "dataset_sha256": digest(dataset),
        "model_sha256": digest(model_dir / "q_table.npz"),
        "source_git_head": revision,
        "source_sha256": source_hashes,
        "evaluation_suite_id": EVALUATION_SUITE_ID,
        "evaluation": evaluation["summary"],
        "evaluation_lluvia": evaluation_rain["summary"],
        "baselines": {
            weather: {name: result["summary"] for name, result in group.items()}
            for weather, group in baselines.items()
        },
        "training_success_rate": float(np.mean([item["success"] for item in metrics])),
        "last_window_success_rate": float(np.mean([
            item["success"] for item in metrics[-training["summary_window"]:]
        ])),
    }
    write_json(model_dir / "metadata.json", metadata)
    write_json(model_dir / "manifest.json", {
        "run_id": run_id,
        "level_id": config["level_id"],
        "environment_version": config["environment_version"],
        "git_commit": revision,
        "config_sha256": metadata["config_sha256"],
        "model_uri": f"models/{run_id}/q_table.npz",
        "model_sha256": metadata["model_sha256"],
        "dataset_sha256": metadata["dataset_sha256"],
        "runtime_ref": "requirements.txt + race_env_v5.py en el commit indicado",
        "evaluation_suite_id": EVALUATION_SUITE_ID,
        "seed": seed,
        "training_weather_mix_probability": training["weather_mix_probability"],
        "state_encoding": metadata["state_encoding"],
    })
    (model_dir / "README.md").write_text(
        "# Rally v5 / N5\n\n"
        "Modelo Q-learning tabular disperso. `q_table.npz` contiene `state_ids` "
        "y `values`; los estados no visitados tienen valores Q cero. Cargue con "
        "`numpy.load(..., allow_pickle=False)`. La codificación y orden de las "
        "11 variables se documentan en `metadata.json`; `config.json` conserva "
        "el ambiente exacto y `manifest.json` identifica la corrida.\n",
        encoding="utf-8",
    )
    env_normal.close()
    env_rain.close()
    return {
        "experiment_id": run_id,
        "seed": seed,
        "dataset": str(dataset),
        "model_dir": str(model_dir),
        "metadata": metadata,
        "metrics": metrics,
        "evaluation": evaluation,
        "evaluation_lluvia": evaluation_rain,
        "baselines": baselines,
        "training_replays": replays,
        "config": config,
    }
