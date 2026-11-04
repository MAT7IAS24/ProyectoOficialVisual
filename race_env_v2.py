"""N2: entorno discreto configurado, independiente de race_env.py (v1)."""
from __future__ import annotations

from copy import deepcopy
import json
import math
from pathlib import Path

import gymnasium as gym
from gymnasium import spaces
import numpy as np

DEFAULT_CONFIG = Path(__file__).resolve().parent / "configs" / "rally-v2.json"


def load_config(path=DEFAULT_CONFIG) -> dict:
    config = deepcopy(path) if isinstance(path, dict) else json.loads(Path(path).read_text(encoding="utf-8"))
    if config["environment_version"] != "rally-v2" or config["reward_version"] != "v2":
        raise ValueError("Se requiere environment_version=rally-v2 y reward_version=v2")
    e, t, r = config["environment"], config["training"], config["reward"]
    for key in ("track_length_meters", "segment_meters", "max_speed_level", "max_steps", "max_off_track_count", "off_track_rollback_segments"):
        if type(e[key]) is not int or e[key] <= 0:
            raise ValueError(f"{key} debe ser entero positivo")
    if e["track_length_meters"] % e["segment_meters"]:
        raise ValueError("La pista debe contener un número entero de tramos")
    if not 0 <= e["initial_speed_level"] <= e["max_speed_level"]:
        raise ValueError("Velocidad inicial fuera de rango")
    if e["initial_fuel"] <= 0 or min(e["fuel_base_cost"], e["fuel_speed_cost"]) < 0:
        raise ValueError("Combustible o consumo inválidos")
    bounds = e["fuel_bucket_thresholds"]
    if bounds != sorted(set(bounds)) or any(not 0 < x < e["initial_fuel"] for x in bounds):
        raise ValueError("Los umbrales de combustible deben ser crecientes e interiores al rango")
    if [(a["name"], a["speed_delta"]) for a in e["actions"]] != [("frenar", -1), ("mantener", 0), ("acelerar", 1)]:
        raise ValueError("Acciones v2: 0=frenar, 1=mantener, 2=acelerar")
    if [z["id"] for z in e["zones"]] != list(range(len(e["zones"]))) or e["zones"][0]["safe_speed"] is not None:
        raise ValueError("Las zonas deben tener IDs consecutivos desde la recta 0")
    segments = [s for z in e["zones"] for s in z["segments"]]
    if len(segments) != len(set(segments)) or any(type(s) is not int or not 0 < s < e["track_length_meters"] // e["segment_meters"] for s in segments):
        raise ValueError("Tramos de zona solapados o fuera de la pista")
    for z in e["zones"]:
        if not 0 < z["grip"] <= 1 or (z["safe_speed"] is not None and not 0 <= z["safe_speed"] <= e["max_speed_level"]):
            raise ValueError("Adherencia o velocidad segura inválida")
    if t["episodes"] < 1 or t["evaluation_episodes"] < 1 or t["summary_window"] < 1:
        raise ValueError("El número de episodios y la ventana deben ser positivos")
    if not 0 < t["alpha"] <= 1 or not 0 <= t["gamma"] <= 1 or not 0 <= t["epsilon_end"] <= t["epsilon_start"] <= 1:
        raise ValueError("Hiperparámetros fuera de rango")
    if not t["seeds"] or len(set(t["seeds"])) != len(t["seeds"]) or any(type(s) is not int or s < 0 for s in [t["seed"], *t["seeds"]]):
        raise ValueError("Las semillas deben ser enteras, no negativas e independientes")
    if any(not math.isfinite(v) for v in r.values()):
        raise ValueError("Las recompensas deben ser finitas")
    return config


class RallyV2Env(gym.Env):
    """Obs Tuple(Discrete(11), Discrete(4), Discrete(4), Discrete(3)).

    Acción Discrete(3): frenar, mantener, acelerar. Ambos espacios se derivan
    del JSON. Los contadores de salidas y premios NO forman parte de la obs,
    conforme al diseño N2; por eso esta observación es parcialmente observable.
    """
    metadata = {"render_modes": []}

    def __init__(self, config=DEFAULT_CONFIG):
        self.config = load_config(config)
        self.e = self.config["environment"]
        self.r = self.config["reward"]
        self.environment_version = self.config["environment_version"]
        self.reward_version = self.config["reward_version"]
        self.segment_count = self.e["track_length_meters"] // self.e["segment_meters"]
        self.state_shape = (self.segment_count + 1, self.e["max_speed_level"] + 1, len(self.e["fuel_bucket_thresholds"]) + 1, len(self.e["zones"]))
        self.observation_space = spaces.Tuple(tuple(spaces.Discrete(n) for n in self.state_shape))
        self.action_space = spaces.Discrete(len(self.e["actions"]))
        self._done = True

    def zone(self, segment):
        return next((z for z in self.e["zones"] if segment in z["segments"]), self.e["zones"][0])

    def observation(self):
        segment = self.position_meters // self.e["segment_meters"]
        bucket = sum(self.fuel > threshold for threshold in self.e["fuel_bucket_thresholds"])
        return (segment, self.speed_level, bucket, self.zone(segment)["id"])

    def encode(self, obs):
        return int(np.ravel_multi_index(obs, self.state_shape))

    def _info(self, **extra):
        zone = self.zone(self.position_meters // self.e["segment_meters"])
        return {"position_meters": self.position_meters, "speed_level": self.speed_level,
                "fuel": self.fuel, "progress_pct": self.position_meters / self.e["track_length_meters"] * 100,
                "remaining_meters": self.e["track_length_meters"] - self.position_meters,
                "zone_type": zone["id"], "zone_name": zone["name"], "grip": zone["grip"],
                "off_track_count": self.off_track_count, "steps": self.steps,
                "termination_cause": self.termination_cause, "environment_version": self.environment_version,
                "reward_version": self.reward_version, **extra}

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        self.position_meters = 0
        self.speed_level = self.e["initial_speed_level"]
        self.fuel = self.e["initial_fuel"]
        self.off_track_count = self.steps = 0
        self.rewarded_segments = {0}
        self.termination_cause = "en_curso"
        self._done = False
        return self.observation(), self._info()

    def step(self, action):
        if self._done:
            raise RuntimeError("Llama reset() antes de iniciar o después de finalizar un episodio")
        if not self.action_space.contains(action):
            raise ValueError(f"Acción inválida: {action}")
        self.steps += 1
        self.speed_level = max(0, min(self.e["max_speed_level"], self.speed_level + self.e["actions"][int(action)]["speed_delta"]))
        driving_speed = self.speed_level
        consumed = min(self.fuel, self.e["fuel_base_cost"] + self.e["fuel_speed_cost"] * driving_speed)
        self.fuel = max(0, self.fuel - consumed)
        current_segment = self.position_meters // self.e["segment_meters"]
        destination = min(self.segment_count, current_segment + driving_speed)
        new_segments, off_track = [], False
        for segment in range(current_segment + 1, destination + 1):
            safe = self.zone(segment)["safe_speed"]
            if safe is not None and driving_speed > safe:
                off_track = True
                self.off_track_count += 1
                self.position_meters = max(0, segment - self.e["off_track_rollback_segments"]) * self.e["segment_meters"]
                self.speed_level = 0
                break
            self.position_meters = segment * self.e["segment_meters"]
            if segment not in self.rewarded_segments:
                self.rewarded_segments.add(segment)
                new_segments.append(segment)
        if self.position_meters >= self.e["track_length_meters"]:
            self.termination_cause = "vuelta_completada"
        elif self.off_track_count >= self.e["max_off_track_count"]:
            self.termination_cause = "salidas_de_pista"
        elif self.fuel <= 0:
            self.termination_cause = "sin_combustible"
        else:
            self.termination_cause = "en_curso"
        terminated = self.termination_cause != "en_curso"
        truncated = not terminated and self.steps >= self.e["max_steps"]
        if truncated:
            self.termination_cause = "limite_pasos"
        completed = self.termination_cause == "vuelta_completada"
        parts = {"step": self.r["step"], "new_segments": self.r["new_segment"] * len(new_segments),
                 "fuel": self.r["fuel_unit"] * consumed, "off_track": self.r["off_track"] if off_track else 0,
                 "finish": self.r["finish"] if completed else 0,
                 "remaining_fuel": self.r["remaining_fuel_unit"] * self.fuel if completed else 0}
        self._done = terminated or truncated
        return self.observation(), float(sum(parts.values())), terminated, truncated, self._info(
            fuel_consumed=consumed, off_track=off_track, newly_rewarded_segments=new_segments, reward_components=parts)
