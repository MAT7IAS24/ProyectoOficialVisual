"""N7: "ver la pista como un piloto".

La física es la misma del N6 (llantas de Pacejka, peso que se mueve, suspensión). Cambia lo que
el agente VE y cómo se le PREMIA, siguiendo a Gran Turismo Sophy (Wurman et al., Nature 2022):

  * Mirada según el tiempo, no según los metros: 8 puntos de la línea central de la pista a 0,5;
    1; 1,5; 2; 2,5; 3; 4 y 5 segundos adelante (a la velocidad actual, mínimo 5 m/s). De cada
    punto recibe dónde queda respecto al coche (adelante y al costado) y la curvatura de la pista
    ahí. A 100 km/h ve 140 m adelante; a 30 km/h, 42 m.
  * Celdas de obstáculos hasta 100 m adelante (antes 60 m): a 100 km/h se necesitan ~45 m para frenar.
  * Recompensa v7: chocar cuesta 5 + 0,01 × velocidad² (chocar a 90 km/h cuesta 11,25 puntos;
    a 30 km/h, 5,7) y derrapar sin control (deslizamiento medio > 6°) tiene un castigo pequeño por
    paso. El avance sigue siendo lo que más suma.

Todas las cifras viven en configs/rally-v7.json.
"""
from __future__ import annotations

from copy import deepcopy
import json
import math
from pathlib import Path

import gymnasium as gym
from gymnasium import spaces
import numpy as np

DEFAULT_CONFIG = Path(__file__).resolve().parent / "configs" / "rally-v7.json"
PATCH_TYPES = ("lodo", "agua", "pasto", "valla", "rampa_foso", "nada")


def load_config(path=DEFAULT_CONFIG, perturbation=None) -> dict:
    config = deepcopy(path) if isinstance(path, dict) else json.loads(Path(path).read_text(encoding="utf-8"))
    if config["environment_version"] != "rally-v7" or config["reward_version"] not in ("v7", "v5"):
        raise ValueError("Se requiere environment_version=rally-v7 y reward_version=v7 (intento 1) o v5 (intento 2)")
    t, p, g = config["track"], config["physics"], config["generator"]
    for key, value in {**t, **p}.items():
        if not isinstance(value, (int, float)) or value < 0:
            raise ValueError(f"{key} debe ser un número no negativo")
    if t["lanes"] < 2 or t["cell_m"] <= 0 or t["checkpoint_every_m"] <= 0:
        raise ValueError("La pista necesita al menos 2 carriles y celdas positivas")
    if not 0 < p["ramp_angle_deg"] < 60 or p["dt_s"] <= 0 or p["substeps"] < 1:
        raise ValueError("Ángulo de rampa o paso de tiempo inválidos")
    if abs(p["cg_to_front_m"] + p["cg_to_rear_m"] - p["wheelbase_m"]) > 1e-6:
        raise ValueError("cg_to_front_m + cg_to_rear_m debe ser igual a wheelbase_m")
    if not (0 <= p["drive_front_share"] <= 1 and 0 <= p["brake_front_share"] <= 1):
        raise ValueError("Los repartos de tracción y frenado deben estar entre 0 y 1")
    probs = g["patch_probabilities"]
    if set(probs) != set(PATCH_TYPES) or abs(sum(probs.values()) - 1) > 1e-9:
        raise ValueError("patch_probabilities debe sumar 1 y cubrir " + ", ".join(PATCH_TYPES))
    for name, terrain in config["terrains"].items():
        if not (0 <= terrain["grip"] <= 1.5 and 0 <= terrain["rolling"] <= 1 and 0 <= terrain["plow"] <= 1):
            raise ValueError(f"Agarre, resistencia o arrastre lateral inválidos en {name}")
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
    """Crea una pista al azar pero reproducible: la misma semilla da la misma pista
    (mismo generador que el N4, así la suite de 30 pistas es comparable)."""
    t, g = config["track"], config["generator"]
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


def magic_formula(alpha, B, C, E):
    """Forma de la fórmula mágica de Pacejka con el máximo normalizado a 1.
    alpha = ángulo de deslizamiento de la llanta (rad). La fuerza real es esto × agarre × peso."""
    x = B * alpha
    return math.sin(C * math.atan(x - E * (x - math.atan(x))))


class RallyV7Env(gym.Env):
    """Contrato (ver docs/rally-v7.md para el detalle de cada número):

    Acción Box(2) en [-1, 1]: [acelerador (+) / freno (-), volante (+ izquierda)].
    Son ÓRDENES: el pedal y el volante reales se mueven hacia ellas a velocidad limitada.
    Observación Box(146): 26 datos del coche + sensores de 6 celdas adelante × 4 carriles
    × 5 rasgos (peligro, rampa, frena, agarre, puente).
    terminated: vuelta completa, demasiados accidentes o atascado. truncated: límite de pasos.
    """
    metadata = {"render_modes": []}
    BASE_OBS = ("velocidad", "rumbo_relativo", "posicion_lateral", "borde_izquierdo", "borde_derecho",
                "curva_aqui", "curva_30m", "curva_60m", "altura", "velocidad_vertical", "en_el_aire",
                "en_el_puente", "combustible", "progreso",
                "velocidad_lateral", "giro_yaw", "volante_real", "pedal_real", "deslizamiento", "agarre_bajo_ruedas",
                "peso_adelante", "peso_afuera", "cabeceo", "balanceo", "compresion_suspension", "deslizamiento_trasero")
    COURSE_TIMES_S = (0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0)     # mirada de piloto: segundos adelante
    COURSE_OBS = tuple(f"pista_{t:g}s_{k}" for t in COURSE_TIMES_S for k in ("adelante", "costado", "curva"))
    HEAD_OBS = BASE_OBS + COURSE_OBS                               # todo lo que va antes de las celdas

    def __init__(self, config=DEFAULT_CONFIG, perturbation=None, layout_seed=None, fixed_layout=None):
        self.config = load_config(config, perturbation)
        self.t, self.p, self.r_cfg = self.config["track"], self.config["physics"], self.config["reward"]
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
        size = len(self.BASE_OBS) + 3 * len(self.COURSE_TIMES_S) + self.lanes * self.look * self.n_feat
        self.observation_space = spaces.Box(-5.0, 5.0, shape=(size,), dtype=np.float32)
        self.action_space = spaces.Box(-1.0, 1.0, shape=(2,), dtype=np.float32)
        self.environment_version = self.config["environment_version"]
        self._done = True

    # ---------- velocidad total (módulo de vx, vy) ----------
    @property
    def v(self):
        return math.hypot(self.vx, self.vy)

    def _stop(self):
        self.vx = self.vy = self.r = 0.0

    @property
    def beta(self):
        """Ángulo de deslizamiento de la carrocería: entre hacia dónde apunta y hacia dónde va."""
        return math.atan2(self.vy, self.vx) if self.v > 0.5 else 0.0

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
                self.grip[lane, c] = ter["grip"] * self.grip_factor
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
        """(nombre, agarre, resistencia a la rodadura, arrastre lateral) del suelo en ese punto."""
        name, ter = self.by_code[self.ground_code(s, lane)]
        return name, ter["grip"] * self.grip_factor, ter["rolling"] * self.rolling_factor, ter["plow"]

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
        self._stop()
        self.delta, self.pedal = 0.0, 0.0
        self.z, self.vz = 0.0, 0.0
        self._reset_body()
        self.airborne, self.on_deck = False, False
        self.fuel = float(self.p["initial_fuel_l"])
        self.max_s, self.checkpoints, self.last_progress_step = self.s, 0, 0
        self.accidents, self.steps = 0, 0
        self.surface = ("asfalto", 1.0 * self.grip_factor)
        self.wheelspin = False
        self.termination_cause = "en_curso"
        self._done = False
        self.poses = [self._pose()]
        return self._obs(), self._info()

    def _reset_body(self):
        """Suspensión en reposo: sin cabeceo, sin balanceo, resortes con el peso estático."""
        self.pitch = self.pitch_rate = 0.0      # cabeceo (rad, + = trompa abajo)
        self.roll = self.roll_rate = 0.0        # balanceo (rad, + = se inclina hacia la derecha)
        self.heave = self.heave_rate = 0.0      # compresión extra de los resortes (m, + = comprimido)
        self.alpha_r = 0.0
        self.loads = [0.25, 0.25, 0.25, 0.25]   # fracción del peso en cada rueda: DI, DD, TI, TD
        self.lifted = False
        self.air_pitch_rate, self.bottomed, self.landing_vz = 0.0, False, None
        self.crash_speeds = getattr(self, "crash_speeds", [])

    def _pose(self):
        """[x, y, z, rumbo, volante, deslizamiento, cabeceo, balanceo, compresión] para la web."""
        x, y, h = self.track.world(min(self.s, self.track.length - 1e-6), self.d)
        return [round(x, 3), round(y, 3), round(self.z, 3), round(h + self.psi, 4), round(self.delta, 3), round(self.beta, 3),
                round(self.pitch, 4), round(self.roll, 4), round(self.heave, 3)]

    def _crash(self, events, reason, back_to=None):
        self.accidents += 1
        self.crash_speeds.append(math.hypot(self.v, self.vz))     # para la recompensa v7 (∝ velocidad²)
        events.append(reason)
        self._stop()
        self.vz, self.z, self.delta, self.pedal = 0.0, 0.0, 0.0, 0.0
        self.airborne, self.on_deck, self.psi = False, False, 0.0
        self._reset_body()
        if back_to is not None:
            self.s = max(0.0, back_to)
        self.d = float(np.clip(self.d, -self.half + 0.5, self.half - 0.5))
        lane = self.lane_of(self.d)
        while self.ground_code(self.s, lane) in "FR" and self.s > 0:
            self.s -= 1.0

    # ---------- dinámica en el suelo ----------
    def _actuators(self, throttle, steer, dt):
        """Volante y pedal se mueven hacia la orden a velocidad limitada (no cambian de golpe)."""
        p = self.p
        target = steer * p["max_steer_rad"]
        step = p["steer_rate_rad_s"] * dt
        self.delta += float(np.clip(target - self.delta, -step, step))
        step = p["pedal_rate_per_s"] * dt
        self.pedal += float(np.clip(throttle - self.pedal, -step, step))

    def _wheel_loads(self):
        """Peso (N) sobre cada rueda [DI, DD, TI, TD] según el estado de la suspensión.

        El cabeceo y el balanceo de la carrocería dicen cuánto peso se pasó: la suspensión es la
        que "decide" cuándo llega la transferencia (con retraso), no la aceleración del instante.
        """
        p, g = self.p, self.p["gravity_mps2"]
        m, h = p["mass_kg"], p["cg_height_m"]
        lf, lr = p["cg_to_front_m"], p["cg_to_rear_m"]
        L, t = lf + lr, p["track_width_m"]
        wh = 2 * math.pi * p["heave_freq_hz"]
        Fz = max(0.0, m * g + m * (wh ** 2 * self.heave + 2 * p["heave_damping"] * wh * self.heave_rate))
        ax_eff = -self.pitch / p["pitch_per_accel_rad"]        # aceleración que "siente" la suspensión
        ay_eff = self.roll / p["roll_per_accel_rad"]
        dX = m * ax_eff * h / L * (Fz / (m * g) if Fz > 0 else 0.0)
        Fzf, Fzr = Fz * lr / L - dX, Fz * lf / L + dX
        dY = m * ay_eff * h / t
        dYf, dYr = dY * p["front_roll_share"], dY * (1 - p["front_roll_share"])
        # ay > 0 = curva a la izquierda -> el peso va a las ruedas de la DERECHA (las de afuera).
        loads = [Fzf / 2 - dYf, Fzf / 2 + dYf, Fzr / 2 - dYr, Fzr / 2 + dYr]
        return [max(0.0, w) for w in loads], Fz

    def _axle_capacity(self, grip, w_left, w_right):
        """Agarre máximo de un eje (N). Cada llanta pierde agarre relativo con más peso
        (sensibilidad a la carga): por eso pasar peso de un lado al otro QUITA agarre al eje."""
        Fz0 = self.p["mass_kg"] * self.p["gravity_mps2"] / 4
        k = self.p["load_sensitivity"]
        cap = 0.0
        for w in (w_left, w_right):
            cap += max(0.0, w * (1 - k * (w / Fz0 - 1)))
        return grip * cap

    def _suspension(self, ax, ay, dt):
        """Cabeceo, balanceo y compresión: resortes con amortiguador que siguen a la aceleración."""
        p = self.p
        z = p["suspension_damping_ratio"]
        wp, wr, wh = 2 * math.pi * p["pitch_freq_hz"], 2 * math.pi * p["roll_freq_hz"], 2 * math.pi * p["heave_freq_hz"]
        pitch_ss = -ax * p["pitch_per_accel_rad"]
        roll_ss = ay * p["roll_per_accel_rad"]
        self.pitch_rate += (wp ** 2 * (pitch_ss - self.pitch) - 2 * z * wp * self.pitch_rate) * dt
        self.pitch += self.pitch_rate * dt
        self.roll_rate += (wr ** 2 * (roll_ss - self.roll) - 2 * z * wr * self.roll_rate) * dt
        self.roll += self.roll_rate * dt
        self.heave_rate += (-wh ** 2 * self.heave - 2 * p["heave_damping"] * wh * self.heave_rate) * dt
        self.heave += self.heave_rate * dt
        travel = p["suspension_travel_m"]
        if self.heave > travel:                      # se acabó el recorrido: tope de goma
            self.heave, self.heave_rate = travel, min(0.0, self.heave_rate)
            self.bottomed = True
        elif self.heave < -travel:
            self.heave, self.heave_rate = -travel, max(0.0, self.heave_rate)

    def _tire_dynamics(self, grip, rolling, plow, dt, events):
        """Modelo de dos ejes con llantas de Pacejka y círculo de agarre (como el N5), pero con el
        peso de cada rueda según la suspensión: transferencia de peso y sensibilidad a la carga."""
        p, g = self.p, self.p["gravity_mps2"]
        m, Iz = p["mass_kg"], p["yaw_inertia_kgm2"]
        lf, lr = p["cg_to_front_m"], p["cg_to_rear_m"]
        L = lf + lr
        vx, vy, r, delta = self.vx, self.vy, self.r, self.delta
        loads, Fz = self._wheel_loads()
        self.loads = [w / max(1.0, Fz) for w in loads] if Fz > 0 else [0.0] * 4
        cap_f = self._axle_capacity(grip, loads[0], loads[1])
        cap_r = self._axle_capacity(grip, loads[2], loads[3])
        lift_limit = p["wheel_lift_fraction"] * m * g / 4
        self.lifted = min(loads) < lift_limit and self.v > 5
        if self.lifted and "levanta_una_rueda" not in events:
            events.append("levanta_una_rueda")

        # 1) Fuerza hacia adelante pedida por el pedal, repartida entre ejes y limitada por el agarre.
        if self.pedal >= 0:
            F = self.pedal * m * p["max_accel_mps2"] if self.fuel > 0 else 0.0
            share = p["drive_front_share"]
        else:
            F = self.pedal * m * p["max_brake_mps2"] if vx > 0.05 else 0.0
            share = p["brake_front_share"]
            if p.get("brake_follows_load", False):
                # Reparto electrónico (EBD): cada eje frena según el peso que lleva en ese momento,
                # así la cola liviana no se bloquea al frenar (como en los coches modernos).
                front = (loads[0] + loads[1]) / max(1.0, sum(loads))
                share = float(np.clip(front, 0.5, 0.85))
        Fxf_req, Fxr_req = F * share, F * (1 - share)
        Fxf = float(np.clip(Fxf_req, -cap_f, cap_f))
        Fxr = float(np.clip(Fxr_req, -cap_r, cap_r))
        self.wheelspin = abs(Fxf_req) > cap_f + 1e-6 or abs(Fxr_req) > cap_r + 1e-6
        if self.wheelspin and self.v > 1:
            tag = "patina_al_acelerar" if F > 0 else "bloquea_los_frenos"
            if tag not in events:
                events.append(tag)

        # 2) Círculo de agarre: lo que se usa para acelerar ya no está para girar.
        lat_f = math.sqrt(max(0.0, cap_f ** 2 - Fxf ** 2))
        lat_r = math.sqrt(max(0.0, cap_r ** 2 - Fxr ** 2))

        # 3) Resistencias: rodadura (terreno) y aire. Solo frenan; nunca empujan hacia atrás.
        V = math.hypot(vx, vy)
        F_roll = -rolling * Fz if vx > 0.05 else 0.0
        F_drag_x = -p["drag_per_v2"] * m * V * vx
        F_drag_y = -p["drag_per_v2"] * m * V * vy

        if vx < p["kinematic_below_mps"]:
            # A muy baja velocidad las llantas no deslizan: modelo cinemático (como el N4).
            ax = (Fxf * math.cos(delta) + Fxr + F_roll + F_drag_x) / m
            self.vx = max(0.0, vx + ax * dt)
            beta_k = math.atan(lr / L * math.tan(delta))
            self.vy = self.vx * math.tan(beta_k)
            self.r = self.vx * math.cos(beta_k) * math.tan(delta) / L
            self.alpha_r = 0.0
            self._suspension(ax if self.vx > 0 else 0.0, self.vx * self.r, dt)
            return

        # 4) Fuerzas laterales de cada eje con la fórmula mágica.
        alpha_f = math.atan2(vy + lf * r, vx) - delta
        alpha_r = math.atan2(vy - lr * r, vx)
        self.alpha_r = alpha_r
        Fyf = -lat_f * magic_formula(alpha_f, p["tire_B_front"], p["tire_C"], p["tire_E"])
        Fyr = -lat_r * magic_formula(alpha_r, p["tire_B_rear"], p["tire_C"], p["tire_E"])
        # Una llanta no puede empujar más de lo necesario para anular su deslizamiento en este
        # subpaso (evita que el cálculo "rebote" de un lado a otro con pasos de 25 ms).
        vlat_f = (vy + lf * r) * math.cos(delta) - vx * math.sin(delta)
        vlat_r = vy - lr * r
        lim_f = m * lr / L * abs(vlat_f) / dt
        lim_r = m * lf / L * abs(vlat_r) / dt
        Fyf = float(np.clip(Fyf, -lim_f, lim_f))
        Fyr = float(np.clip(Fyr, -lim_r, lim_r))
        # 5) Barro: surcos que siguen la pista (igual que el N5).
        u = V * math.sin(self.psi + math.atan2(vy, vx))
        F_rut = -plow * m * g * float(np.clip(u / 0.5, -1.0, 1.0))
        F_rut = float(np.clip(F_rut, -m * abs(u) / dt, m * abs(u) / dt))
        F_rut_x, F_rut_y = F_rut * math.sin(self.psi), F_rut * math.cos(self.psi)
        M_rut = -plow * m * g * 0.5 * float(np.clip(self.psi / 0.1, -1.0, 1.0))
        lim_rut = 0.5 * Iz * abs(self.psi) / dt ** 2
        M_rut = float(np.clip(M_rut, -lim_rut, lim_rut))

        Fx_body = Fxf * math.cos(delta) - Fyf * math.sin(delta) + Fxr + F_roll + F_drag_x + F_rut_x
        Fy_body = Fxf * math.sin(delta) + Fyf * math.cos(delta) + Fyr + F_drag_y + F_rut_y
        ax = Fx_body / m + vy * r
        ay = Fy_body / m - vx * r
        r_dot = (lf * (Fyf * math.cos(delta) + Fxf * math.sin(delta)) - lr * Fyr + M_rut) / Iz
        self.vx = max(0.0, vx + ax * dt)
        self.vy = vy + ay * dt
        self.r = r + r_dot * dt
        if self.v > p["max_speed_mps"]:
            k = p["max_speed_mps"] / self.v
            self.vx, self.vy = self.vx * k, self.vy * k
        # La suspensión responde a lo que empujan las llantas (aceleración que siente el pasajero).
        self._suspension(Fx_body / m, Fy_body / m, dt)

    def _move(self, dt):
        """Avanza en coordenadas de pista: la carrocería apunta a psi, pero se mueve hacia psi + beta."""
        V = self.v
        course = self.psi + (math.atan2(self.vy, self.vx) if V > 1e-6 else 0.0)
        kappa = self.track.curvature(self.s)
        ds = V * math.cos(course) / max(0.2, 1 - kappa * self.d) * dt
        self.s += ds
        self.d += V * math.sin(course) * dt
        self.psi += self.r * dt - kappa * ds
        self.psi = (self.psi + math.pi) % (2 * math.pi) - math.pi

    def _substep(self, throttle, steer, dt, events):
        p, g = self.p, self.p["gravity_mps2"]
        self._actuators(throttle, steer, dt)
        lane = self.lane_of(self.d)
        if self.airborne:
            # En el aire solo manda la gravedad: las llantas no tocan nada, no se puede acelerar ni girar.
            self._move(dt)
            self.vz -= g * dt
            self.z += self.vz * dt
            # En el aire la carrocería gira despacio hacia la trayectoria y los resortes se estiran.
            self.pitch += self.air_pitch_rate * dt
            self.roll *= max(0.0, 1 - 3 * dt)
            self.heave += (-p["suspension_travel_m"] * 0.6 - self.heave) * min(1.0, 8 * dt)
            self.heave_rate = 0.0
            k = max(0.0, 1 - p["drag_per_v2"] * self.v * dt)
            self.vx, self.vy = self.vx * k, self.vy * k
            lane = self.lane_of(self.d)
            if abs(self.d) > self.half + 2:
                self._crash(events, "sale_volando_de_la_pista", back_to=self.max_s - 15)
                return
            deck_h = self.deck_height(self.s, lane)
            if deck_h is not None and self.vz <= 0 and deck_h - p["landing_lip_m"] <= self.z <= deck_h + 0.05:
                self._land(deck_h, events, on_deck=True)
                return
            # La losa mide 0,45 m de grueso y el coche 1,2 m de alto.
            if deck_h is not None and deck_h - 0.45 - 1.2 < self.z < deck_h - p["landing_lip_m"]:
                self._crash(events, "choca_con_el_borde_del_puente", back_to=self.s - 12)
                return
            gh = self.ground_height(self.s, lane)
            if gh is not None and self.z <= gh:
                drop = getattr(self, "_takeoff_z", 0.0) - gh
                if getattr(self, "_from_deck", False) and drop >= p["fall_accident_drop_m"]:
                    self._crash(events, "cae_del_puente")
                    return
                self._land(gh, events, on_deck=False)
                return
            if gh is None and self.z < -1.0:
                self._crash(events, "cae_en_foso", back_to=self.pit_start(self.s, lane) - 45)
            return

        # --- en el suelo o sobre el puente ---
        if self.on_deck:
            name, grip, rolling, plow = "puente", 1.0 * self.grip_factor, 0.015 * self.rolling_factor, 0.0
        else:
            name, grip, rolling, plow = self.terrain(self.s, lane)
        self.surface = (name, grip)
        self._tire_dynamics(grip, rolling, plow, dt, events)
        self._move(dt)
        lane = self.lane_of(self.d)
        slip = abs(math.degrees(self.beta))
        if slip > p["spin_deg"] and self.v > 5:
            self._crash(events, "hace_un_trompo", back_to=self.s - 5)
            return
        if slip > p["slide_event_deg"] and self.v > 8 and "derrapa" not in events:
            events.append("derrapa")
        # Bordes de la pista.
        if not self.on_deck and abs(self.d) > self.half:
            self._crash(events, "sale_de_la_pista", back_to=self.s - 5)
            return
        # Sobre el puente: hueco o borde lateral -> empieza a caer.
        if self.on_deck:
            dh = self.deck_height(self.s, lane)
            off_side = (self.deck_code(self.s, lane) == "-" or abs(self.d - self.lane_center(lane)) > self.W / 2
                        or self.layout["deck"][lane][min(self.cell_of(self.s), self.n_cells - 1)] == "-")
            if dh is None or off_side:
                if self.deck_code(self.s, lane) == "-" and self.z <= 0.3:
                    self.on_deck = False  # terminó la bajada del puente
                else:
                    self._takeoff(0.0, events, "vuela_sobre_el_hueco" if dh is None and not off_side else "se_sale_del_puente", from_deck=True)
                return
            self.z = dh
            return
        # Vallas: frenan en seco.
        if self.ground_code(self.s, lane) == "B":
            center = (self.cell_of(self.s) + 0.5) * self.cell
            if abs(self.s - center) <= p["barrier_length_m"] / 2 + 0.5:
                if self.v > p["barrier_crash_speed_mps"]:
                    self._crash(events, "choca_con_la_valla", back_to=center - 6)
                else:
                    events.append("frena_contra_la_valla")
                    self.s = center - 6
                    self._stop()
                return
        # Rampa y foso.
        gh = self.ground_height(self.s, lane)
        if gh is None:
            self._takeoff(0.0, events, "cae_al_foso", from_deck=False)
            self.z = 0.0
            return
        if self.ground_code(self.s, lane) == "R":
            self.z = gh
            if gh > 0:
                self.pitch = -math.radians(p["ramp_angle_deg"])   # trompa arriba sobre la rampa
            if gh >= p["ramp_height_m"] - 1e-6 or self.cell_of(self.s + self.v * dt) != self.cell_of(self.s):
                ang = math.radians(p["ramp_angle_deg"])
                self.z = p["ramp_height_m"]
                v = self.v
                self.vx, self.vy = self.vx * math.cos(ang), self.vy * math.cos(ang)
                self._takeoff(v * math.sin(ang), events, "salta_la_rampa", from_deck=False)
            return
        self.z = 0.0
        if name in ("lodo", "agua", "pasto") and f"pisa_{name}" not in events:
            events.append(f"pisa_{name}")

    def _takeoff(self, vz, events, reason, from_deck):
        self.airborne, self.on_deck = True, False
        self.vz = vz
        # Gira la trompa hacia abajo lo justo para llegar paralelo a la trayectoria al caer.
        g = self.p["gravity_mps2"]
        self.air_pitch_rate = (-self.pitch * g / max(1.0, vz)) if vz > 0.5 else 0.15
        self._takeoff_z, self._from_deck = self.z, from_deck
        events.append(reason)
        self.jumps_now.append({"s": round(self.s, 2), "v": round(math.hypot(self.v, vz), 2), "vz": round(vz, 2), "from_deck": from_deck})

    def _land(self, height, events, on_deck):
        if -self.vz > self.p["hard_landing_vz_mps"]:
            self._crash(events, "aterrizaje_duro")
            return
        self.airborne, self.on_deck = False, on_deck
        # Los resortes reciben la velocidad de caída: se comprimen, dan más peso (más agarre) y rebotan.
        self.heave_rate = -self.vz
        self.landing_vz = round(-self.vz, 2)
        self.z, self.vz = height, 0.0
        self.pitch, self.pitch_rate = 0.0, -self.pitch * 2.0
        events.append("aterriza_en_el_puente" if on_deck else "aterriza")

    def step(self, action):
        if self._done:
            raise RuntimeError("Llama reset() antes de iniciar o después de finalizar un episodio")
        a = np.asarray(action, dtype=np.float64).reshape(-1)
        if a.shape != (2,) or not np.all(np.isfinite(a)):
            raise ValueError(f"Acción inválida: {action}")
        throttle, steer = float(np.clip(a[0], -1, 1)), float(np.clip(a[1], -1, 1))
        p, rw = self.p, self.r_cfg
        self.steps += 1
        events, self.jumps_now = [], []
        self.bottomed, self.landing_vz = False, None
        self.crash_speeds = []
        acc_before = self.accidents
        dt = p["dt_s"] / p["substeps"]
        poses, slips = [], []
        for _ in range(p["substeps"]):
            self._substep(throttle, steer, dt, events)
            if self.bottomed and "golpea_los_topes" not in events:
                events.append("golpea_los_topes")
            poses.append(self._pose())
            if not self.airborne and self.v > 2:
                slips.append(abs(math.degrees(self.beta)))
            if self.s >= self.track.length:
                break
        self.poses = poses
        burn = (p["fuel_idle_l_per_s"] + p["fuel_throttle_l_per_s"] * max(self.pedal, 0.0)) * p["dt_s"]
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
        slip_mean = float(np.mean(slips)) if slips else 0.0
        parts = {"avance": rw["per_meter"] * gained, "checkpoints": rw["checkpoint"] * new_cp, "paso": rw["step"],
                 "accidentes": sum(rw["accident"] - rw["accident_per_v2"] * v ** 2 for v in self.crash_speeds),
                 "derrape": -rw["slip_per_deg"] * max(0.0, slip_mean - rw["slip_free_deg"]), "atasco": rw["stalled"] if self.termination_cause == "atascado" else 0.0,
                 "meta": rw["finish"] if done_ok else 0.0,
                 "combustible_sobrante": rw["remaining_fuel_per_l"] * self.fuel if done_ok else 0.0}
        self._done = terminated or truncated
        return self._obs(), float(sum(parts.values())), terminated, truncated, self._info(
            events=events, reward_components=parts, accidents_now=crashes, fuel_used=used,
            new_checkpoints=new_cp, jumps=self.jumps_now, action=[throttle, steer],
            slip_deg_max=round(max(slips), 2) if slips else 0.0, slip_deg_mean=round(float(np.mean(slips)), 2) if slips else 0.0,
            landing_vz=self.landing_vz, crash_speeds_kmh=[round(v * 3.6, 1) for v in self.crash_speeds])

    # ---------- lo que "ve" el coche ----------
    def _obs(self):
        L, R, p = self.track.length, self.t["radius_m"], self.p
        base = [self.v / p["max_speed_mps"], float(np.clip(self.psi / 0.6, -2, 2)), self.d / self.half,
                (self.half - self.d) / (2 * self.half), (self.half + self.d) / (2 * self.half),
                self.track.curvature(self.s) * R, self.track.curvature(self.s + 30) * R, self.track.curvature(self.s + 60) * R,
                self.z / 4.0, float(np.clip(self.vz / 10.0, -2, 2)), float(self.airborne), float(self.on_deck),
                self.fuel / p["initial_fuel_l"], min(self.s, L) / L,
                float(np.clip(self.vy / 5.0, -3, 3)), float(np.clip(self.r / 1.0, -3, 3)), self.delta / p["max_steer_rad"],
                self.pedal, float(np.clip(self.beta / 0.5, -3, 3)), self.surface[1],
                (self.loads[0] + self.loads[1]) * 2 - 1, (self.loads[1] + self.loads[3]) * 2 - 1,
                float(np.clip(self.pitch / 0.05, -3, 3)), float(np.clip(self.roll / 0.08, -3, 3)),
                self.heave / p["suspension_travel_m"], float(np.clip(self.alpha_r / 0.15, -3, 3))]
        base += self._course_points()
        cells = (np.floor((self.s + 5.0 + self.cell * np.arange(self.look)) / self.cell)).astype(int)
        valid = cells < self.n_cells
        idx = np.clip(cells, 0, self.n_cells - 1)
        feats = np.stack([self.hazard[:, idx], self.ramp[:, idx], self.slow[:, idx], self.grip[:, idx], self.deckm[:, idx]], axis=-1)
        feats[:, ~valid, :] = np.array([0, 0, 0.05, 1.0, 0])
        obs = np.concatenate([np.asarray(base, np.float32), feats.reshape(-1).astype(np.float32)])
        if self.obs_noise:
            obs = obs + self.np_random.normal(0, self.obs_noise, size=obs.shape).astype(np.float32)
        return np.clip(obs, -5, 5).astype(np.float32)

    def _course_points(self):
        """Mirada tipo Sophy: dónde queda la línea central a t segundos (adelante y al costado, en
        el sistema del coche) y cuánto se curva la pista ahí."""
        R, sc = self.t["radius_m"], self.config["sensors"]
        x0, y0, h0 = self.track.world(min(self.s, self.track.length - 1e-6), self.d)
        head = h0 + self.psi
        ch, sh = math.cos(head), math.sin(head)
        v = max(self.v, sc["course_min_speed_mps"])
        out = []
        for t in self.COURSE_TIMES_S:
            dist = min(v * t, sc["course_max_m"])
            x, y, _ = self.track.center(self.s + dist)
            dx, dy = x - x0, y - y0
            fwd, left = dx * ch + dy * sh, -dx * sh + dy * ch
            out += [fwd / sc["course_max_m"], float(np.clip(left / 20.0, -5, 5)), self.track.curvature(self.s + dist) * R]
        return out

    def _info(self, **extra):
        lane = self.lane_of(self.d)
        here = "puente" if self.on_deck else ("aire" if self.airborne else self.terrain(self.s, lane)[0])
        x, y, h = self.track.world(min(self.s, self.track.length - 1e-6), self.d)
        return {"s": round(self.s, 3), "d": round(self.d, 3), "psi": round(self.psi, 4), "x": round(x, 3), "y": round(y, 3),
                "z": round(self.z, 3), "heading": round(h + self.psi, 4), "speed_mps": round(self.v, 3),
                "speed_kmh": round(self.v * 3.6, 1), "vx": round(self.vx, 3), "vy": round(self.vy, 3),
                "yaw_rate": round(self.r, 4), "slip_deg": round(math.degrees(self.beta), 2),
                "steer_deg": round(math.degrees(self.delta), 2), "pedal": round(self.pedal, 3), "wheelspin": self.wheelspin,
                "pitch_deg": round(math.degrees(self.pitch), 2), "roll_deg": round(math.degrees(self.roll), 2),
                "heave_m": round(self.heave, 3), "wheel_loads": [round(w, 3) for w in self.loads], "wheel_lifted": self.lifted,
                "rear_slip_deg": round(math.degrees(self.alpha_r), 2),
                "vz": round(self.vz, 3), "airborne": self.airborne,
                "on_deck": self.on_deck, "lane": lane, "terrain_here": here, "fuel_l": round(self.fuel, 3),
                "progress_pct": round(min(self.s, self.track.length) / self.track.length * 100, 2),
                "checkpoints": self.checkpoints, "accidents": self.accidents, "steps": self.steps,
                "termination_cause": self.termination_cause, "environment_version": self.environment_version,
                "reward_version": self.config["reward_version"], "layout_seed": self.layout["seed"],
                "poses": self.poses, "events": [], "jumps": [], **extra}


class DiscreteRallyV7(gym.Wrapper):
    """Versión discretizada para Q-learning (igual que el N4: 720 estados × 15 acciones).

    Arreglo del N5: en el N4 la tabla leía la velocidad y el rumbo exactos del simulador,
    así que el "sensor ruidoso" no la afectaba. Ahora, si la condición tiene ruido, la
    tabla también lee velocidad, rumbo y posición con ese ruido (en las mismas unidades
    normalizadas que la red), y la comparación es justa.
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

    def readings(self):
        """Velocidad (m/s), rumbo (rad) y posición lateral (m) como las 've' el agente, con ruido si lo hay."""
        e = self.env
        v, psi, d = e.v, e.psi, e.d
        if e.obs_noise:
            n = e.np_random.normal(0, e.obs_noise, size=3)
            v += n[0] * e.p["max_speed_mps"]
            psi += n[1] * 0.6
            d += n[2] * e.half
        return v, psi, d

    def encode(self):
        e = self.env
        v, psi, d = self.readings()
        idx = (int(np.digitize(v, self.speed_bins)), e.lane_of(d), int(np.digitize(psi, self.psi_bins)), self.ahead_type(), int(e.airborne))
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
