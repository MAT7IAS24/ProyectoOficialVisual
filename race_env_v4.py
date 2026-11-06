"""N4: pista larga de 4 carriles con observación completa para Q-learning.

La dinámica se versiona aquí junto con las dimensiones nuevas del estado; v1,
v2 y v3 permanecen sin cambios. Las reglas viven en configs/rally-v4.json.
"""
from __future__ import annotations

from copy import deepcopy
import json
import math
from pathlib import Path

import gymnasium as gym
from gymnasium import spaces
import numpy as np

DEFAULT_CONFIG = Path(__file__).resolve().parent / "configs" / "rally-v4.json"
KINDS = {"free", "slow", "skid", "pit", "barrel", "ramp", "deck", "deck_gap"}
DECK_KINDS = {"deck", "deck_gap"}
OBSERVATION_FIELDS = (
    "tramo", "nivel_velocidad", "balde_combustible", "carril", "capa",
    "terreno_adelante", "combustible_exact", "accidentes", "pasos",
    "mejor_tramo", "lluvia",
)


def apply_perturbation(config: dict, name: str) -> dict:
    """Devuelve una copia con la perturbación `name` aplicada al suelo."""
    config = deepcopy(config)
    perturbation = config.get("perturbations", {}).get(name)
    if perturbation is None:
        raise ValueError(f"Perturbación desconocida: {name}")
    for item in perturbation["ground_overrides"]:
        row = list(config["environment"]["lane_layout"][item["lane"]]["ground"])
        for segment in item["segments"]:
            row[segment] = item["code"]
        config["environment"]["lane_layout"][item["lane"]]["ground"] = "".join(row)
    config["perturbation_applied"] = name
    return config


def load_config(path=DEFAULT_CONFIG, perturbation=None) -> dict:
    config = deepcopy(path) if isinstance(path, dict) else json.loads(Path(path).read_text(encoding="utf-8"))
    if config["environment_version"] != "rally-v4" or config["reward_version"] != "v4":
        raise ValueError("Se requiere environment_version=rally-v4 y reward_version=v4")
    if perturbation is not None:
        config = apply_perturbation(config, perturbation)
    e, t, r = config["environment"], config["training"], config["reward"]
    for key in ("track_length_meters", "segment_meters", "lanes", "max_speed_level", "max_steps", "max_accidents", "accident_rollback_segments", "lane_change_max_speed"):
        if type(e[key]) is not int or e[key] <= 0:
            raise ValueError(f"{key} debe ser entero positivo")
    if e["track_length_meters"] % e["segment_meters"]:
        raise ValueError("La pista debe contener un número entero de tramos")
    segments = e["track_length_meters"] // e["segment_meters"]
    if not 0 <= e["initial_lane"] < e["lanes"]:
        raise ValueError("Carril inicial fuera de rango")
    if not 0 <= e["initial_speed_level"] <= e["max_speed_level"]:
        raise ValueError("Velocidad inicial fuera de rango")
    if e["initial_fuel"] <= 0 or min(e["fuel_base_cost"], e["fuel_speed_cost"], e["fuel_lane_change_cost"]) < 0:
        raise ValueError("Combustible o consumo inválidos")
    bounds = e["fuel_bucket_thresholds"]
    if bounds != sorted(set(bounds)) or any(not 0 < x < e["initial_fuel"] for x in bounds):
        raise ValueError("Los umbrales de combustible deben ser crecientes e interiores al rango")
    expected = [("frenar", -1, 0), ("mantener", 0, 0), ("acelerar", 1, 0), ("carril_izquierda", 0, -1), ("carril_derecha", 0, 1)]
    if [(a["name"], a["speed_delta"], a["lane_delta"]) for a in e["actions"]] != expected:
        raise ValueError("Acciones v4: 0=frenar 1=mantener 2=acelerar 3=carril_izquierda 4=carril_derecha")
    terrains = e["terrains"]
    if [x["id"] for x in terrains] != list(range(len(terrains))) or len({x["code"] for x in terrains}) != len(terrains):
        raise ValueError("Los terrenos necesitan IDs consecutivos y códigos únicos")
    if any(x["kind"] not in KINDS for x in terrains):
        raise ValueError("Tipo de terreno desconocido")
    by_code = {x["code"]: x for x in terrains}
    if terrains[0]["kind"] != "free":
        raise ValueError("El terreno 0 debe ser el asfalto libre")
    flight = {int(k): v for k, v in e["flight_segments"].items()}
    for x in terrains:
        if x["kind"] == "ramp":
            needed = range(x["min_speed"], e["max_speed_level"] + 1)
            if any(s not in flight or flight[s] < 1 for s in needed) or not 1 <= x["slow_cap"] <= e["max_speed_level"]:
                raise ValueError("Cada velocidad que activa una rampa necesita una distancia de vuelo positiva")
    layout = e["lane_layout"]
    if len(layout) != e["lanes"]:
        raise ValueError("lane_layout debe tener un elemento por carril")
    for lane in layout:
        ground, deck = lane["ground"], lane["deck"]
        if len(ground) != segments or len(deck) != segments:
            raise ValueError(f"{lane['name']}: ground y deck deben medir {segments} tramos")
        if ground[0] != terrains[0]["code"] or deck[0] != "-":
            raise ValueError("El tramo 0 debe ser asfalto limpio en todos los carriles")
        for c in ground:
            if c not in by_code or by_code[c]["kind"] in DECK_KINDS:
                raise ValueError(f"Código de suelo inválido: {c!r}")
        for c in deck:
            if c != "-" and (c not in by_code or by_code[c]["kind"] not in DECK_KINDS):
                raise ValueError(f"Código de puente inválido: {c!r}")
    if t["episodes"] < 1 or t["evaluation_episodes"] < 1 or t["summary_window"] < 1:
        raise ValueError("El número de episodios y la ventana deben ser positivos")
    if not 0 < t["alpha"] <= 1 or not 0 <= t["gamma"] <= 1 or not 0 <= t["epsilon_end"] <= t["epsilon_start"] <= 1:
        raise ValueError("Hiperparámetros fuera de rango")
    if not t["seeds"] or len(set(t["seeds"])) != len(t["seeds"]) or any(type(s) is not int or s < 0 for s in [t["seed"], *t["seeds"]]):
        raise ValueError("Las semillas deben ser enteras, no negativas e independientes")
    if not 0 <= t["weather_mix_probability"] <= 1:
        raise ValueError("weather_mix_probability debe estar entre 0 y 1")
    if any(not math.isfinite(v) for v in r.values()):
        raise ValueError("Las recompensas deben ser finitas")
    return config


class RallyV4Env(gym.Env):
    """Observation includes resource/history values that affect the transition.

    (segment, speed, fuel bucket, lane, layer, terrain ahead, exact fuel,
    accidents, steps, best segment, weather).
    """
    metadata = {"render_modes": []}

    def __init__(self, config=DEFAULT_CONFIG, perturbation=None):
        self.config = load_config(config, perturbation)
        self.e = self.config["environment"]
        self.r = self.config["reward"]
        self.environment_version = self.config["environment_version"]
        self.reward_version = self.config["reward_version"]
        self.segment_count = self.e["track_length_meters"] // self.e["segment_meters"]
        self.lane_count = self.e["lanes"]
        self.weather_id = int(self.config.get("perturbation_applied") == "lluvia")
        self.terrain_by_code = {x["code"]: x for x in self.e["terrains"]}
        self.terrain_by_id = {x["id"]: x for x in self.e["terrains"]}
        self.meta_id = len(self.e["terrains"])
        self.flight = {int(k): v for k, v in self.e["flight_segments"].items()}
        self.ground = [list(x["ground"]) for x in self.e["lane_layout"]]
        self.deck = [list(x["deck"]) for x in self.e["lane_layout"]]
        self.state_shape = (
            self.segment_count + 1,
            self.e["max_speed_level"] + 1,
            len(self.e["fuel_bucket_thresholds"]) + 1,
            self.lane_count,
            2,
            self.meta_id + 1,
            self.e["initial_fuel"] + 1,
            self.e["max_accidents"] + 1,
            self.e["max_steps"] + 1,
            self.segment_count + 1,
            2,
        )
        self.observation_space = spaces.Tuple(tuple(spaces.Discrete(n) for n in self.state_shape))
        self.action_space = spaces.Discrete(len(self.e["actions"]))
        self._done = True

    # ---- lectura del mundo -------------------------------------------------
    def cell_code(self, lane, segment, layer):
        """Código de la casilla. En capa 1 un '-' significa 'aquí ya no hay puente'."""
        if layer == 1 and self.deck[lane][segment] != "-":
            return self.deck[lane][segment]
        return self.ground[lane][segment]

    def ahead_id(self):
        nxt = self.segment + 1
        if nxt >= self.segment_count:
            return self.meta_id
        return self.terrain_by_code[self.cell_code(self.lane, nxt, self.layer)]["id"]

    def observation(self):
        bucket = sum(self.fuel > threshold for threshold in self.e["fuel_bucket_thresholds"])
        return (
            self.segment, self.speed_level, bucket, self.lane, self.layer,
            self.ahead_id(), self.fuel, self.accidents, self.steps,
            self.best_segment, self.weather_id,
        )

    def encode(self, obs):
        return int(np.ravel_multi_index(obs, self.state_shape))

    def terrain_here(self):
        if self.segment >= self.segment_count:
            return "meta"
        return self.terrain_by_code[self.cell_code(self.lane, self.segment, self.layer)]["name"]

    def _info(self, **extra):
        ahead = self.ahead_id()
        return {"position_meters": self.segment * self.e["segment_meters"], "segment": self.segment,
                "lane": self.lane, "layer": self.layer, "layer_name": "puente" if self.layer else "suelo",
                "speed_level": self.speed_level, "fuel": self.fuel,
                "progress_pct": self.segment / self.segment_count * 100,
                "remaining_meters": self.e["track_length_meters"] - self.segment * self.e["segment_meters"],
                "terrain_here": self.terrain_here(), "terrain_ahead": "meta" if ahead == self.meta_id else self.terrain_by_id[ahead]["name"],
                "accidents": self.accidents, "steps": self.steps, "best_segment": self.best_segment,
                "steps_remaining": self.e["max_steps"] - self.steps,
                "weather": "lluvia" if self.weather_id else "normal",
                "termination_cause": self.termination_cause,
                "environment_version": self.environment_version, "reward_version": self.reward_version,
                "jump": None, "crash_segment": None, "events": [], "path": [], **extra}

    # ---- ciclo Gymnasium ---------------------------------------------------
    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        self.segment = 0
        self.best_segment = 0
        self.lane = int(self.np_random.integers(self.lane_count)) if self.e["random_start_lane"] else self.e["initial_lane"]
        self.layer = 0
        self.speed_level = self.e["initial_speed_level"]
        self.fuel = self.e["initial_fuel"]
        self.accidents = self.steps = 0
        self.termination_cause = "en_curso"
        self._done = False
        return self.observation(), self._info()

    def _crash(self, cell, reason):
        """Accidente: vuelve atrás, se detiene y baja al suelo."""
        self.accidents += 1
        self.speed_level = 0
        self.layer = 0
        self._crash_cell = cell
        return max(0, cell - self.e["accident_rollback_segments"]), True, reason, True

    def _resolve_entry(self, t, cell, landing=False):
        """Efecto de entrar a una casilla. Devuelve (tramo, accidente, evento, termina_el_paso)."""
        kind, speed = t["kind"], self.speed_level
        if kind == "slow" and speed > t["speed_cap"]:
            self.speed_level = t["speed_cap"]
            return cell, False, f"frenado_por_{t['name']}", True
        if kind == "skid" and speed > t["safe_speed"]:
            return self._crash(cell, "derrape_en_agua")
        if kind == "pit":
            return self._crash(cell, "cae_en_foso")
        if kind == "barrel":
            return self._crash(cell, "choca_con_barril")
        if kind == "deck_gap":
            if landing or speed < t["min_speed"]:
                self.accidents += 1
                self.speed_level = 0
                self.layer = 0
                self._crash_cell = cell
                return cell, True, "cae_del_puente", True
            return cell, False, "cruza_el_hueco_del_puente", False
        return cell, False, None, False

    def step(self, action):
        if self._done:
            raise RuntimeError("Llama reset() antes de iniciar o después de finalizar un episodio")
        if not self.action_space.contains(action):
            raise ValueError(f"Acción inválida: {action}")
        e, r = self.e, self.r
        act = e["actions"][int(action)]
        self.steps += 1
        self.speed_level = max(0, min(e["max_speed_level"], self.speed_level + act["speed_delta"]))
        driving_speed = self.speed_level
        events, path, jump, accidents_now = [], [], None, 0
        self._crash_cell = None
        changed_lane = False
        if act["lane_delta"]:
            new_lane = self.lane + act["lane_delta"]
            if self.layer == 1:
                events.append("cambio_de_carril_bloqueado_en_puente")
            elif not 0 <= new_lane < self.lane_count:
                events.append("cambio_de_carril_bloqueado_por_muro")
            elif driving_speed > e["lane_change_max_speed"]:
                events.append("derrape_al_cambiar_de_carril")
                self._crash_cell = self.segment
                self.accidents += 1
                accidents_now += 1
                self.speed_level = 0
            else:
                self.lane, changed_lane = new_lane, True
                events.append("cambio_de_carril")
        consumed = min(self.fuel, e["fuel_base_cost"] + e["fuel_speed_cost"] * driving_speed + (e["fuel_lane_change_cost"] if changed_lane else 0))
        self.fuel = max(0, self.fuel - consumed)

        seg, budget = self.segment, (0 if accidents_now else driving_speed)
        while budget > 0 and seg < self.segment_count:
            nxt = seg + 1
            budget -= 1
            if nxt >= self.segment_count:
                seg = self.segment_count
                break
            if self.layer == 1 and self.deck[self.lane][nxt] == "-":
                self.layer = 0
                events.append("baja_del_puente")
            t = self.terrain_by_code[self.cell_code(self.lane, nxt, self.layer)]
            if t["kind"] == "ramp":
                if self.speed_level >= t["min_speed"]:
                    flight = self.flight[self.speed_level]
                    land = nxt + flight
                    jump = {"from_segment": nxt, "to_segment": min(land, self.segment_count), "flight": flight, "speed_level": self.speed_level}
                    events.append("salta_la_rampa")
                    path.append({"segment": nxt, "layer": 0, "mode": "rampa"})
                    if land >= self.segment_count:
                        seg = self.segment_count
                        break
                    self.layer = 1 if self.deck[self.lane][land] != "-" else 0
                    lt = self.terrain_by_code[self.cell_code(self.lane, land, self.layer)]
                    seg, accident, event, _ = self._resolve_entry(lt, land, landing=True)
                    path.append({"segment": land, "layer": self.layer, "mode": "aterrizaje"})
                    if self.layer == 1:
                        events.append("aterriza_en_el_puente")
                    if event:
                        events.append(event)
                    accidents_now += accident
                    break
                if t["barrel_on_ramp"]:
                    seg, _, event, _ = self._crash(nxt, "choca_con_el_barril_de_la_rampa")
                    events.append(event)
                    accidents_now += 1
                    break
                seg = nxt
                self.speed_level = min(self.speed_level, t["slow_cap"])
                events.append("sube_despacio_la_rampa")
                path.append({"segment": nxt, "layer": 0, "mode": "suelo"})
                break
            seg, accident, event, stop = self._resolve_entry(t, nxt)
            path.append({"segment": seg, "layer": self.layer, "mode": "suelo"})
            if event:
                events.append(event)
            accidents_now += accident
            if stop:
                break
        self.segment = seg

        progress = max(0, seg - self.best_segment)
        self.best_segment = max(self.best_segment, seg)
        if self.segment >= self.segment_count:
            self.termination_cause = "vuelta_completada"
        elif self.accidents >= e["max_accidents"]:
            self.termination_cause = "demasiados_accidentes"
        elif self.fuel <= 0:
            self.termination_cause = "sin_combustible"
        else:
            self.termination_cause = "en_curso"
        terminated = self.termination_cause != "en_curso"
        truncated = not terminated and self.steps >= e["max_steps"]
        if truncated:
            self.termination_cause = "limite_pasos"
        completed = self.termination_cause == "vuelta_completada"
        parts = {"step": r["step"], "progress": r["new_segment"] * progress, "fuel": r["fuel_unit"] * consumed,
                 "accident": r["accident"] * accidents_now, "finish": r["finish"] if completed else 0,
                 "remaining_fuel": r["remaining_fuel_unit"] * self.fuel if completed else 0}
        self._done = terminated or truncated
        return self.observation(), float(sum(parts.values())), terminated, truncated, self._info(
            fuel_consumed=consumed, accidents_now=accidents_now, new_segments=progress,
            jump=jump, crash_segment=self._crash_cell, events=events, path=path, reward_components=parts)
