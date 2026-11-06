"""N4: rally con física continua y una pista distinta en cada episodio.

Novedades frente a v3 (que sigue intacto en race_env_v3.py):
  * La velocidad es real, en metros por segundo, y cambia con aceleración (m/s²).
  * Cada terreno tiene "agarre" (cuánto se puede acelerar, frenar o girar) y
    "resistencia a la rodadura" (cuánto frena por sí solo). El lodo traba porque
    su resistencia es 0,30: quita 0,30 × 9,81 ≈ 2,9 m/s de velocidad cada segundo.
  * El coche gira con el modelo de bicicleta: la dirección de las ruedas y la
    distancia entre ejes deciden cuánto rota. Si gira más de lo que permite el
    agarre, se va de largo (subviraje), como un carro real en una curva mojada.
  * Las rampas lanzan el coche con un ángulo de 20°; en el aire manda la gravedad
    (9,81 m/s²). El puente está a 3 m de altura, tiene un hueco de 6 m y se puede
    caer por los lados.
  * Las vallas frenan el coche en seco al chocarlas.
  * La pista (obstáculos, rampas y puente) se genera al azar en cada episodio a
    partir de una semilla: el agente no puede memorizarla.

Todas las cifras viven en configs/rally-v4.json. La web solo reproduce lo que
este archivo calcula (posiciones x, y, altura y orientación en cada subpaso).
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
PATCH_TYPES = ("lodo", "agua", "pasto", "valla", "rampa_foso", "nada")


def load_config(path=DEFAULT_CONFIG, perturbation=None) -> dict:
    config = deepcopy(path) if isinstance(path, dict) else json.loads(Path(path).read_text(encoding="utf-8"))
    if config["environment_version"] != "rally-v4" or config["reward_version"] != "v4":
        raise ValueError("Se requiere environment_version=rally-v4 y reward_version=v4")
    t, p, g = config["track"], config["physics"], config["generator"]
    for key, value in {**t, **{k: v for k, v in p.items()}}.items():
        if not isinstance(value, (int, float)) or value < 0:
            raise ValueError(f"{key} debe ser un número no negativo")
    if t["lanes"] < 2 or t["cell_m"] <= 0 or t["checkpoint_every_m"] <= 0:
        raise ValueError("La pista necesita al menos 2 carriles y celdas positivas")
    if not 0 < p["ramp_angle_deg"] < 60 or p["dt_s"] <= 0 or p["substeps"] < 1:
        raise ValueError("Ángulo de rampa o paso de tiempo inválidos")
    probs = g["patch_probabilities"]
    if set(probs) != set(PATCH_TYPES) or abs(sum(probs.values()) - 1) > 1e-9:
        raise ValueError("patch_probabilities debe sumar 1 y cubrir " + ", ".join(PATCH_TYPES))
    for name, terrain in config["terrains"].items():
        if not (0 <= terrain["grip"] <= 1.5 and 0 <= terrain["rolling"] <= 1):
            raise ValueError(f"Agarre o resistencia inválidos en {name}")
    if perturbation is not None:
        if perturbation not in config["perturbations"]:
            raise ValueError(f"Perturbación desconocida: {perturbation}")
        config["perturbation_applied"] = perturbation
    return config


class Track:
    """Óvalo: dos rectas unidas por dos semicírculos. s = metros recorridos sobre la
    línea central; d = metros hacia la izquierda (positivo = hacia el centro)."""

    def __init__(self, straight, radius):
        self.S, self.R = float(straight), float(radius)
        self.length = 2 * self.S + 2 * math.pi * self.R

    def curvature(self, s):
        s = s % self.length
        S, R = self.S, self.R
        if s < S or S + math.pi * R <= s < 2 * S + math.pi * R:
            return 0.0
        return 1.0 / R

    def center(self, s):
        """(x, y, rumbo) del punto de la línea central."""
        s = s % self.length
        S, R = self.S, self.R
        if s < S:
            return -S / 2 + s, -R, 0.0
        s -= S
        if s < math.pi * R:
            a = -math.pi / 2 + s / R
            return S / 2 + R * math.cos(a), R * math.sin(a), a + math.pi / 2
        s -= math.pi * R
        if s < S:
            return S / 2 - s, R, math.pi
        s -= S
        a = math.pi / 2 + s / R
        return -S / 2 + R * math.cos(a), R * math.sin(a), a + math.pi / 2

    def world(self, s, d):
        x, y, h = self.center(s)
        return x - d * math.sin(h), y + d * math.cos(h), h


def generate_layout(config, seed):
    """Crea una pista al azar pero reproducible: la misma semilla da la misma pista."""
    t, g, p = config["track"], config["generator"], config["physics"]
    track = Track(t["straight_m"], t["radius_m"])
    lanes, cell = t["lanes"], t["cell_m"]
    n = int(math.ceil(track.length / cell))
    rng = np.random.default_rng(seed)
    ground = [["."] * n for _ in range(lanes)]
    deck = [["-"] * n for _ in range(lanes)]
    first = int(t["start_clear_m"] // cell)
    last = n - int(math.ceil(t["finish_clear_m"] / cell))
    sec = int(g["section_m"] // cell)
    kinds = list(g["patch_probabilities"])
    weights = np.array([g["patch_probabilities"][k] for k in kinds])
    lo, hi = g["patch_length_cells"]
    for start in range(first, last, sec):
        end = min(start + sec, last)
        for lane in range(lanes):
            kind = kinds[rng.choice(len(kinds), p=weights)]
            if kind == "nada" or end - start < 3:
                continue
            if kind == "rampa_foso":
                c = int(rng.integers(start, end - 2))
                ground[lane][c], ground[lane][c + 1], ground[lane][c + 2] = "R", "F", "F"
            elif kind == "valla":
                ground[lane][int(rng.integers(start, end))] = "B"
            else:
                length = int(rng.integers(lo, hi + 1))
                c = int(rng.integers(start, max(start + 1, end - length + 1)))
                code = config["terrains"][kind]["code"]
                for k in range(c, min(c + length, end)):
                    ground[lane][k] = code
        blocked = [lane for lane in range(lanes) if any(ground[lane][k] in "BFR" for k in range(start, end))]
        if len(blocked) > lanes - g["min_free_lanes_per_section"]:
            keep_free = int(rng.integers(lanes))
            for k in range(start, end):
                if ground[keep_free][k] in "BFR":
                    ground[keep_free][k] = "."
    if rng.random() < g["bridge_probability"]:
        length = int(rng.integers(g["bridge_length_cells"][0], g["bridge_length_cells"][1] + 1))
        lane = int(rng.integers(lanes))
        r = int(rng.integers(first, max(first + 1, last - length - 4)))
        for k in range(r, r + length + 3):
            ground[lane][k] = "."
        ground[lane][r] = "R"
        ground[lane][r + 1] = "F"
        for k in range(r + 2, r + 2 + length):
            deck[lane][k] = "P"
            ground[lane][k] = "LAF"[int(rng.integers(3))] if k > r + 2 else "F"
        deck[lane][r + 2 + length // 2] = "G"
        deck[lane][r + 2 + length - 1] = "D"
    return {"seed": int(seed), "cells": n, "cell_m": cell, "lanes": lanes,
            "ground": ["".join(row) for row in ground], "deck": ["".join(row) for row in deck]}


class RallyV4Env(gym.Env):
    """Contrato (ver docs/rally-v4.md para el detalle de cada número):

    Acción Box(2) en [-1, 1]: [acelerador (+) / freno (-), giro (+ izquierda)].
    Observación Box(134) en [-1, 1] aprox.: 14 datos del coche + sensores de
    6 celdas adelante × 4 carriles × 5 rasgos (peligro, rampa, frena, agarre, puente).
    terminated: vuelta completa o demasiados accidentes. truncated: límite de pasos.
    """
    metadata = {"render_modes": []}
    BASE_OBS = ("velocidad", "rumbo_relativo", "posicion_lateral", "borde_izquierdo", "borde_derecho",
                "curva_aqui", "curva_30m", "curva_60m", "altura", "velocidad_vertical", "en_el_aire",
                "en_el_puente", "combustible", "progreso")

    def __init__(self, config=DEFAULT_CONFIG, perturbation=None, layout_seed=None, fixed_layout=None):
        self.config = load_config(config, perturbation)
        self.t, self.p, self.r = self.config["track"], self.config["physics"], self.config["reward"]
        self.track = Track(self.t["straight_m"], self.t["radius_m"])
        self.lanes, self.W, self.cell = self.t["lanes"], self.t["lane_width_m"], self.t["cell_m"]
        self.half = self.lanes * self.W / 2
        pert = self.config["perturbations"].get(perturbation, {}) if perturbation else {}
        self.grip_factor = pert.get("grip_factor", 1.0)
        self.rolling_factor = pert.get("rolling_factor", 1.0)
        self.obs_noise = pert.get("obs_noise_std", 0.0)
        self.by_code = {v["code"]: (k, v) for k, v in self.config["terrains"].items()}
        self.fixed_layout, self.layout_seed = fixed_layout, layout_seed
        self.look = self.config["sensors"]["lookahead_cells"]
        self.n_feat = len(self.config["sensors"]["features_per_cell"])
        size = len(self.BASE_OBS) + self.lanes * self.look * self.n_feat
        self.observation_space = spaces.Box(-5.0, 5.0, shape=(size,), dtype=np.float32)
        self.action_space = spaces.Box(-1.0, 1.0, shape=(2,), dtype=np.float32)
        self.environment_version = self.config["environment_version"]
        self._done = True

    # ---------- pista ----------
    def _set_layout(self, layout):
        self.layout = layout
        n, L = layout["cells"], self.lanes
        self.n_cells = n
        self.hazard = np.zeros((L, n), np.float32); self.ramp = np.zeros((L, n), np.float32)
        self.slow = np.zeros((L, n), np.float32); self.grip = np.zeros((L, n), np.float32)
        self.deckm = np.zeros((L, n), np.float32)
        for lane in range(L):
            for c in range(n):
                name, ter = self.by_code[layout["ground"][lane][c]]
                self.hazard[lane, c] = 1.0 if name in ("valla", "foso") else 0.0
                self.ramp[lane, c] = 1.0 if name == "rampa" else 0.0
                self.slow[lane, c] = ter["rolling"] * self.rolling_factor / 0.3
                self.grip[lane, c] = ter["grip"] * self.grip_factor / 0.9
                dk = layout["deck"][lane][c]
                self.deckm[lane, c] = {"-": 0.0, "P": 1.0, "D": 1.0, "G": -1.0}[dk]

    def lane_of(self, d):
        return int(min(self.lanes - 1, max(0, round((self.lanes - 1) / 2 - d / self.W))))

    def lane_center(self, lane):
        return ((self.lanes - 1) / 2 - lane) * self.W

    def cell_of(self, s):
        return int(s // self.cell)

    def ground_code(self, s, lane):
        c = self.cell_of(s)
        return self.layout["ground"][lane][c] if 0 <= c < self.n_cells else "."

    def deck_code(self, s, lane):
        c = self.cell_of(s)
        return self.layout["deck"][lane][c] if 0 <= c < self.n_cells else "-"

    def terrain(self, s, lane):
        name, ter = self.by_code[self.ground_code(s, lane)]
        return name, ter["grip"] * self.grip_factor, ter["rolling"] * self.rolling_factor

    def ground_height(self, s, lane):
        """Altura del suelo: 0, salvo en la rampa (sube en sus últimos metros) o un foso (None = hueco)."""
        code = self.ground_code(s, lane)
        if code == "F":
            return None
        if code == "R":
            ramp_len = self.p["ramp_height_m"] / math.tan(math.radians(self.p["ramp_angle_deg"]))
            into = s - (self.cell_of(s) + 1) * self.cell + ramp_len
            return max(0.0, min(self.p["ramp_height_m"], into * math.tan(math.radians(self.p["ramp_angle_deg"]))))
        return 0.0

    def pit_start(self, s, lane):
        """Comienzo (en metros) del foso en el que está s, contando la rampa que lo antecede."""
        c = self.cell_of(s)
        while c > 0 and self.layout["ground"][lane][c - 1] in "FR":
            c -= 1
        return c * self.cell

    def deck_height(self, s, lane):
        """Altura del piso del puente en ese punto, o None si ahí no hay puente."""
        code = self.deck_code(s, lane)
        H = self.p["deck_height_m"]
        if code == "P":
            return H
        if code == "D":
            frac = (s - self.cell_of(s) * self.cell) / self.cell
            return H * (1 - frac)
        if code == "G":
            into = s - self.cell_of(s) * self.cell
            gap = self.config["generator"]["bridge_gap_m"]
            a = (self.cell - gap) / 2
            return None if a <= into < a + gap else H
        return None

    # ---------- Gymnasium ----------
    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        options = options or {}
        if "layout" in options:
            layout = options["layout"]
        elif self.fixed_layout is not None:
            layout = self.fixed_layout
        else:
            lseed = options.get("layout_seed", self.layout_seed if self.layout_seed is not None else int(self.np_random.integers(2**31)))
            layout = generate_layout(self.config, lseed)
        self._set_layout(layout)
        start_lane = int(self.np_random.integers(self.lanes))
        self.s, self.d, self.psi = 2.0, self.lane_center(start_lane), 0.0
        self.v, self.z, self.vz = 0.0, 0.0, 0.0
        self.airborne, self.on_deck = False, False
        self.fuel = float(self.p["initial_fuel_l"])
        self.max_s, self.checkpoints, self.last_progress_step = self.s, 0, 0
        self.accidents, self.steps = 0, 0
        self.termination_cause = "en_curso"
        self._done = False
        x, y, h = self.track.world(self.s, self.d)
        self.poses = [[round(x, 3), round(y, 3), 0.0, round(h, 4)]]
        return self._obs(), self._info()

    def _crash(self, events, reason, back_to=None):
        self.accidents += 1
        events.append(reason)
        self.v, self.vz, self.z = 0.0, 0.0, 0.0
        self.airborne, self.on_deck, self.psi = False, False, 0.0
        if back_to is not None:
            self.s = max(0.0, back_to)
        self.d = float(np.clip(self.d, -self.half + 0.5, self.half - 0.5))
        lane = self.lane_of(self.d)
        while self.ground_code(self.s, lane) in "FR" and self.s > 0:
            self.s -= 1.0

    def _substep(self, throttle, steer, dt, events):
        p, g = self.p, self.p["gravity_mps2"]
        lane = self.lane_of(self.d)
        if self.airborne:
            # En el aire solo manda la gravedad: no se puede acelerar ni girar.
            vx = self.v
            self.s += vx * math.cos(self.psi) * dt
            self.d += vx * math.sin(self.psi) * dt
            self.vz -= g * dt
            self.z += self.vz * dt
            self.v = max(0.0, self.v - p["drag_per_v2"] * self.v ** 2 * dt)
            lane = self.lane_of(self.d)
            if abs(self.d) > self.half + 2:
                self._crash(events, "sale_volando_de_la_pista", back_to=self.max_s - 15)
                return
            deck_h = self.deck_height(self.s, lane)
            if deck_h is not None and self.vz <= 0 and deck_h - p["landing_lip_m"] <= self.z <= deck_h + 0.05:
                self._land(deck_h, events, on_deck=True)
                return
            # La losa mide 0,45 m de grueso y el coche 1,2 m de alto: si llega a la losa por debajo
            # del borde pero sin pasar por debajo de ella, choca contra el borde.
            if deck_h is not None and deck_h - 0.45 - 1.2 < self.z < deck_h - p["landing_lip_m"]:
                self._crash(events, "choca_con_el_borde_del_puente", back_to=self.s - 12)
                return
            gh = self.ground_height(self.s, lane)
            if gh is not None and self.z <= gh:
                drop = getattr(self, "_takeoff_z", 0.0) - gh
                fell_from_deck = getattr(self, "_from_deck", False) and drop >= p["fall_accident_drop_m"]
                if fell_from_deck:
                    self._crash(events, "cae_del_puente")
                    return
                self._land(gh, events, on_deck=False)
                return
            if gh is None and self.z < -1.0:
                # Reaparece 45 m antes del foso: espacio para tomar impulso (con 6 m/s² llega a ~23 m/s).
                self._crash(events, "cae_en_foso", back_to=self.pit_start(self.s, lane) - 45)
            return

        # --- en el suelo o sobre el puente ---
        if self.on_deck:
            name, grip, rolling = "puente", 0.9 * self.grip_factor, 0.015 * self.rolling_factor
        else:
            name, grip, rolling = self.terrain(self.s, lane)
        # 1) Velocidad: acelerador y freno limitados por el agarre; el terreno y el aire frenan solos.
        a_drive = min(max(throttle, 0.0) * p["max_accel_mps2"], grip * g) if self.fuel > 0 else 0.0
        a_brake = min(max(-throttle, 0.0) * p["max_brake_mps2"], grip * g)
        a_resist = rolling * g + p["drag_per_v2"] * self.v ** 2
        self.v = float(np.clip(self.v + (a_drive - a_brake - a_resist) * dt, 0.0, p["max_speed_mps"]))
        # 2) Giro (modelo de bicicleta). Si pide más giro del que da el agarre, se va de largo.
        delta = steer * p["max_steer_rad"]
        yaw_rate = self.v / p["wheelbase_m"] * math.tan(delta)
        max_yaw = grip * g / max(self.v, 0.5)
        if abs(yaw_rate) > max_yaw:
            yaw_rate = math.copysign(max_yaw, yaw_rate)
            if "derrapa_por_poco_agarre" not in events and self.v > 8:
                events.append("derrapa_por_poco_agarre")
        kappa = self.track.curvature(self.s)
        ds = self.v * math.cos(self.psi) / max(0.2, 1 - kappa * self.d) * dt
        self.s += ds
        self.d += self.v * math.sin(self.psi) * dt
        self.psi += yaw_rate * dt - kappa * ds
        self.psi = (self.psi + math.pi) % (2 * math.pi) - math.pi
        lane = self.lane_of(self.d)
        # 3) Bordes de la pista.
        if not self.on_deck and abs(self.d) > self.half:
            self._crash(events, "sale_de_la_pista", back_to=self.s - 5)
            return
        # 4) Sobre el puente: hueco o borde lateral -> empieza a caer.
        if self.on_deck:
            dh = self.deck_height(self.s, lane)
            off_side = self.deck_code(self.s, lane) == "-" or abs(self.d - self.lane_center(lane)) > self.W / 2 or self.layout["deck"][lane][min(self.cell_of(self.s), self.n_cells - 1)] == "-"
            if dh is None or off_side:
                if self.deck_code(self.s, lane) == "-" and self.z <= 0.3:
                    self.on_deck = False  # terminó la bajada del puente
                else:
                    self._takeoff(self.v, 0.0, events, "vuela_sobre_el_hueco" if dh is None and not off_side else "se_sale_del_puente", from_deck=True)
                return
            self.z = dh
            if dh <= 0.05 and self.deck_code(self.s, lane) == "D":
                pass
            return
        # 5) Vallas: frenan en seco.
        if self.ground_code(self.s, lane) == "B":
            center = (self.cell_of(self.s) + 0.5) * self.cell
            if abs(self.s - center) <= self.p["barrier_length_m"] / 2 + 0.5:
                # La valla frena en seco y el coche rebota 6 m: queda espacio para girar y esquivarla.
                if self.v > p["barrier_crash_speed_mps"]:
                    self._crash(events, "choca_con_la_valla", back_to=center - 6)
                else:
                    events.append("frena_contra_la_valla")
                    self.s, self.v = center - 6, 0.0
                return
        # 6) Rampa y foso.
        gh = self.ground_height(self.s, lane)
        if gh is None:
            self._takeoff(self.v, 0.0, events, "cae_al_foso", from_deck=False)
            self.z = 0.0
            return
        if self.ground_code(self.s, lane) == "R":
            self.z = gh
            if gh >= p["ramp_height_m"] - 1e-6 or self.cell_of(self.s + self.v * dt) != self.cell_of(self.s):
                ang = math.radians(p["ramp_angle_deg"])
                self.z = p["ramp_height_m"]
                self._takeoff(self.v * math.cos(ang), self.v * math.sin(ang), events, "salta_la_rampa", from_deck=False)
            return
        self.z = 0.0
        if name in ("lodo", "agua", "pasto") and f"pisa_{name}" not in events:
            events.append(f"pisa_{name}")

    def _takeoff(self, v_horizontal, vz, events, reason, from_deck):
        self.airborne, self.on_deck = True, False
        self.v, self.vz = v_horizontal, vz
        self._takeoff_z, self._from_deck = self.z, from_deck
        events.append(reason)
        self.jumps_now.append({"s": round(self.s, 2), "v": round(math.hypot(v_horizontal, vz), 2), "vz": round(vz, 2), "from_deck": from_deck})

    def _land(self, height, events, on_deck):
        if -self.vz > self.p["hard_landing_vz_mps"]:
            self._crash(events, "aterrizaje_duro")
            return
        self.airborne, self.on_deck = False, on_deck
        self.z, self.vz = height, 0.0
        events.append("aterriza_en_el_puente" if on_deck else "aterriza")

    def step(self, action):
        if self._done:
            raise RuntimeError("Llama reset() antes de iniciar o después de finalizar un episodio")
        a = np.asarray(action, dtype=np.float64).reshape(-1)
        if a.shape != (2,) or not np.all(np.isfinite(a)):
            raise ValueError(f"Acción inválida: {action}")
        throttle, steer = float(np.clip(a[0], -1, 1)), float(np.clip(a[1], -1, 1))
        p, r = self.p, self.r
        self.steps += 1
        events, self.jumps_now = [], []
        acc_before = self.accidents
        dt = p["dt_s"] / p["substeps"]
        poses = []
        for _ in range(p["substeps"]):
            self._substep(throttle, steer, dt, events)
            x, y, h = self.track.world(self.s, self.d)
            poses.append([round(x, 3), round(y, 3), round(self.z, 3), round(h + self.psi, 4)])
            if self.s >= self.track.length:
                break
        self.poses = poses
        burn = (p["fuel_idle_l_per_s"] + p["fuel_throttle_l_per_s"] * max(throttle, 0.0)) * p["dt_s"]
        used = min(self.fuel, burn)
        self.fuel -= used
        gained = max(0.0, min(self.s, self.track.length) - self.max_s)
        new_cp = int(min(self.s, self.track.length) // self.t["checkpoint_every_m"]) - int(self.max_s // self.t["checkpoint_every_m"])
        new_cp = max(0, new_cp)
        if gained > 0.5:
            self.last_progress_step = self.steps
        self.max_s = max(self.max_s, min(self.s, self.track.length))
        self.checkpoints += new_cp
        crashes = self.accidents - acc_before
        if self.s >= self.track.length:
            self.termination_cause = "vuelta_completada"
        elif self.accidents >= self.config["episode"]["max_accidents"]:
            self.termination_cause = "demasiados_accidentes"
        elif self.steps - self.last_progress_step >= self.config["episode"]["stall_steps"]:
            self.termination_cause = "atascado"
        else:
            self.termination_cause = "en_curso"
        terminated = self.termination_cause != "en_curso"
        truncated = not terminated and self.steps >= self.config["episode"]["max_steps"]
        if truncated:
            self.termination_cause = "limite_pasos"
        done_ok = self.termination_cause == "vuelta_completada"
        parts = {"avance": r["per_meter"] * gained, "checkpoints": r["checkpoint"] * new_cp, "paso": r["step"],
                 "accidentes": r["accident"] * crashes, "atasco": r["stalled"] if self.termination_cause == "atascado" else 0.0,
                 "meta": r["finish"] if done_ok else 0.0,
                 "combustible_sobrante": r["remaining_fuel_per_l"] * self.fuel if done_ok else 0.0}
        self._done = terminated or truncated
        return self._obs(), float(sum(parts.values())), terminated, truncated, self._info(
            events=events, reward_components=parts, accidents_now=crashes, fuel_used=used,
            new_checkpoints=new_cp, jumps=self.jumps_now, action=[throttle, steer])

    # ---------- lo que "ve" el coche ----------
    def _obs(self):
        L, R = self.track.length, self.t["radius_m"]
        base = [self.v / self.p["max_speed_mps"], float(np.clip(self.psi / 0.6, -2, 2)), self.d / self.half,
                (self.half - self.d) / (2 * self.half), (self.half + self.d) / (2 * self.half),
                self.track.curvature(self.s) * R, self.track.curvature(self.s + 30) * R, self.track.curvature(self.s + 60) * R,
                self.z / 4.0, float(np.clip(self.vz / 10.0, -2, 2)), float(self.airborne), float(self.on_deck),
                self.fuel / self.p["initial_fuel_l"], min(self.s, L) / L]
        cells = (np.floor((self.s + 5.0 + self.cell * np.arange(self.look)) / self.cell)).astype(int)
        valid = cells < self.n_cells
        idx = np.clip(cells, 0, self.n_cells - 1)
        feats = np.stack([self.hazard[:, idx], self.ramp[:, idx], self.slow[:, idx], self.grip[:, idx], self.deckm[:, idx]], axis=-1)
        feats[:, ~valid, :] = np.array([0, 0, 0.05, 1.0, 0])
        obs = np.concatenate([np.asarray(base, np.float32), feats.reshape(-1).astype(np.float32)])
        if self.obs_noise:
            obs = obs + self.np_random.normal(0, self.obs_noise, size=obs.shape).astype(np.float32)
        return np.clip(obs, -5, 5).astype(np.float32)

    def _info(self, **extra):
        lane = self.lane_of(self.d)
        here = "puente" if self.on_deck else ("aire" if self.airborne else self.terrain(self.s, lane)[0])
        x, y, h = self.track.world(min(self.s, self.track.length - 1e-6), self.d)
        return {"s": round(self.s, 3), "d": round(self.d, 3), "psi": round(self.psi, 4), "x": round(x, 3), "y": round(y, 3),
                "z": round(self.z, 3), "heading": round(h + self.psi, 4), "speed_mps": round(self.v, 3),
                "speed_kmh": round(self.v * 3.6, 1), "vz": round(self.vz, 3), "airborne": self.airborne,
                "on_deck": self.on_deck, "lane": lane, "terrain_here": here, "fuel_l": round(self.fuel, 3),
                "progress_pct": round(min(self.s, self.track.length) / self.track.length * 100, 2),
                "checkpoints": self.checkpoints, "accidents": self.accidents, "steps": self.steps,
                "termination_cause": self.termination_cause, "environment_version": self.environment_version,
                "reward_version": self.config["reward_version"], "layout_seed": self.layout["seed"],
                "poses": self.poses, "events": [], "jumps": [], **extra}


class DiscreteRallyV4(gym.Wrapper):
    """Versión discretizada para Q-learning (la guía pide documentar la pérdida de resolución).

    Acciones: 3 de acelerador (frenar, soltar, acelerar) × 5 de giro = 15.
    Estado: velocidad (6 rangos) × carril (4) × rumbo (3) × qué hay justo adelante en
    su carril (5 tipos) × en el aire (2) = 720 casillas. Se pierde: la posición exacta
    dentro del carril, lo que hay en los otros carriles y la curvatura.
    """
    THROTTLE = (-1.0, 0.0, 1.0)
    STEER = (-0.3, -0.08, 0.0, 0.08, 0.3)

    def __init__(self, env):
        super().__init__(env)
        q = env.config["training"]["qlearning"]
        self.speed_bins, self.psi_bins = np.array(q["speed_bins"]), np.array(q["psi_bins"])
        self.shape = (len(self.speed_bins) + 1, env.lanes, len(self.psi_bins) + 1, 5, 2)
        self.action_space = spaces.Discrete(len(self.THROTTLE) * len(self.STEER))
        self.observation_space = spaces.Discrete(int(np.prod(self.shape)))

    def ahead_type(self):
        e = self.env
        lane = e.lane_of(e.d)
        for k in range(2):
            code = e.ground_code(e.s + 5 + 10 * k, lane)
            if code in "BF":
                return 3
            if code == "R":
                return 4
            if code == "A":
                return 2
            if code in "LS":
                return 1
        return 0

    def encode(self):
        e = self.env
        idx = (int(np.digitize(e.v, self.speed_bins)), e.lane_of(e.d), int(np.digitize(e.psi, self.psi_bins)), self.ahead_type(), int(e.airborne))
        return int(np.ravel_multi_index(idx, self.shape))

    def to_continuous(self, action):
        a = int(action)
        return np.array([self.THROTTLE[a // len(self.STEER)], self.STEER[a % len(self.STEER)]], np.float32)

    def reset(self, **kwargs):
        _, info = self.env.reset(**kwargs)
        return self.encode(), info

    def step(self, action):
        _, reward, terminated, truncated, info = self.env.step(self.to_continuous(action))
        return self.encode(), reward, terminated, truncated, info
