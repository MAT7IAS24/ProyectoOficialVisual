"""Entrenamiento y evaluación del nivel N6 (peso, suspensión y aterrizajes).

Igual que el N5 (intento 2): el mejor punto del entrenamiento se elige en pistas de
VALIDACIÓN y la tasa de aprendizaje baja hasta 0. Nuevo: la red recibe 146 números (6 de
carga y suspensión) y se miden cabeceo, balanceo, ruedas levantadas y aterrizajes.

Compara, con el MISMO presupuesto de pasos y en las MISMAS pistas nunca vistas:
  * PPO (Stable-Baselines3 + PyTorch): red neuronal 64×64 que recibe los 146 números.
  * Q-learning: tabla de 720 estados × 15 acciones (versión discretizada del ambiente).
  * Referencias: política aleatoria y política de reglas escritas a mano.

Empaquetado de cada red (sección 11 de la guía): pesos SB3 (.zip, incluye el
optimizador para poder continuar), normalización (vecnormalize.pkl y
normalization.json), red exportada a ONNX con la normalización incluida
(policy.onnx, verificada contra SB3), manifiesto y ficha del modelo.
"""
from __future__ import annotations

import copy
import csv
import hashlib
import json
import math
from pathlib import Path
import subprocess
import time
import uuid

import numpy as np

from race_env_v6 import DiscreteRallyV6, RallyV6Env, generate_layout, load_config

ROOT = Path(__file__).resolve().parent
SOURCE_FILES = ("race_env_v6.py", "training_v6.py", "pipeline_v6.py", "configs/rally-v6.json")
EVALUATION_SUITE_ID = "rally-v6-suite-1"   # mismas 30 semillas de pista que el N4


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def git_head():
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()


def evaluation_layouts(config, count=None):
    """La suite fija: pistas con semillas 100000, 100001, ... que NUNCA se usan para entrenar."""
    t = config["training"]
    count = count or t["evaluation_episodes"]
    return [generate_layout(config, t["evaluation_layout_seed_offset"] + i) for i in range(count)]


def validation_layouts(config):
    """Pistas de VALIDACIÓN (semillas 200000, 200001, ...): sirven para elegir el mejor punto del
    entrenamiento sin mirar las 30 pistas del examen (la suite), que quedan solo para el resultado final."""
    t = config["training"]
    count = t.get("validation_episodes", 0)
    return [generate_layout(config, t.get("validation_layout_seed_offset", 200000) + i) for i in range(count)]


def score_of(summary):
    """Orden para elegir el mejor punto: primero vueltas completas, luego avance medio, luego retorno."""
    return (summary["success_rate"], summary["mean_progress_pct"], summary["mean_return"])


# ---------------- políticas de referencia ----------------
def random_policy(env, rng):
    return lambda obs: rng.uniform(-1, 1, size=2).astype(np.float32)


# Ganancias del volante de las reglas. En el N6 se reajustaron porque con transferencia de peso el
# coche reacciona con retraso: más amortiguación del giro (0,12 -> 0,35), más corrección del rumbo
# real (0,6 -> 0,9) y cambio de carril más suave a más de 10 m/s. Se eligieron probando 9 variantes
# en las 30 pistas de la suite (ver docs/rally-v6.md); con las del N5 las reglas bajaban a 53 %.
RULE_GAINS = {"lateral": 0.06, "lateral_ref_mps": 10.0, "course": 0.9, "yaw": 0.35}
K_BRAKE_TURN = 0.0   # probado 1,5 y 3 (soltar el freno al girar): empeoró, se deja en 0


def rule_policy(env):
    """Reglas a mano usando los mismos sensores: elegir el carril vecino más despejado,
    centrarse en él, ir a 18 m/s (12 si hay lodo/agua adelante, 22 si hay rampa, 14 si hay que esquivar).

    Cambio del N5: como ahora el coche tiene inercia y el volante tarda en girar, la regla
    también mira la dirección real de movimiento (rumbo + deslizamiento) y la velocidad de
    giro, para no "serpentear" (lo mismo que hace un conductor al contravolantear)."""
    def act(obs):
        e = env
        lane = e.lane_of(e.d)
        look = obs[len(e.BASE_OBS):].reshape(e.lanes, e.look, 5)
        cost = look[:, :5, 0].sum(1) * 5 + look[:, :3, 2].sum(1) + (1 - np.clip(look[:, :3, 3], 0, 1)).sum(1) * 0.5
        options = [l for l in (lane - 1, lane, lane + 1) if 0 <= l < e.lanes]
        options = [l for l in options if l == lane or look[l, 0, 0] == 0]   # no cruzar sobre un peligro
        target = min(options, key=lambda l: cost[l] + 0.4 * abs(l - lane))
        err = e.lane_center(target) - e.d
        kappa = e.track.curvature(e.s + 0.5 * e.v)
        course = e.psi + e.beta                                  # hacia dónde se mueve de verdad
        yaw_err = e.r - e.v * kappa                              # gira más (o menos) de lo que pide la curva
        k_lat = RULE_GAINS["lateral"] * min(1.0, RULE_GAINS["lateral_ref_mps"] / max(1.0, e.v))   # más suave a más velocidad
        delta = math.atan(e.p["wheelbase_m"] * kappa) + k_lat * err - RULE_GAINS["course"] * course - RULE_GAINS["yaw"] * yaw_err
        steer = delta / e.p["max_steer_rad"]
        if look[lane, :2, 1].max() > 0:
            vt = 22.0
        elif look[lane, :2, 2].max() > 0.3 or look[lane, :2, 3].min() < 0.5:
            vt = 12.0
        else:
            vt = 18.0
        if target != lane or look[lane, :3, 0].max() > 0:
            vt = min(vt, 14.0)                                   # cambiar de carril o esquivar: más despacio
        # "Control de tracción" de un buen conductor: no pedir más del 60 % del agarre para acelerar o
        # frenar, así queda agarre para girar (círculo de agarre). Sin esto, en lluvia hace trompos.
        g = e.p["gravity_mps2"] * e.surface[1]
        hi, lo = min(1.0, 0.6 * g / e.p["max_accel_mps2"]), min(1.0, 0.6 * g / e.p["max_brake_mps2"])
        lo *= max(0.25, 1 - K_BRAKE_TURN * min(1.0, abs(steer)))
        return np.array([np.clip((vt - e.v) * 0.3, -lo, hi), np.clip(steer, -1, 1)], np.float32)
    return act


# ---------------- pruebas de banco (N6) ----------------
def bench_tests(config):
    """Tres pruebas como las de una revista de autos, en una pista de asfalto sin obstáculos:
    frenada a fondo desde 100 km/h, curva constante y caída desde un salto."""
    env = RallyV6Env(config)
    env.reset(seed=0, options={"layout_seed": 0})
    flat = dict(env.layout)
    flat["ground"] = [["." for _ in row] for row in flat["ground"]]
    flat["deck"] = [["-" for _ in row] for row in flat["deck"]]
    out = {}
    # 1) Frenada a fondo derecho desde 100 km/h.
    env.reset(seed=0, options={"layout": flat}); env.s, env.d, env.vx = 5.0, 0.0, 100 / 3.6
    start, dive, rear = env.s, 0.0, 1.0
    while env.v > 0.3 and env.steps < 100:
        _, _, _, _, info = env.step([-1.0, 0.0])
        dive, rear = max(dive, info["pitch_deg"]), min(rear, info["wheel_loads"][2] + info["wheel_loads"][3])
    out["frenada_100_m"], out["cabeceo_max_deg"], out["peso_atras_al_frenar"] = round(env.s - start, 2), round(dive, 2), round(rear, 3)
    # 2) Curva constante: volante fijo a 54 km/h hasta estabilizar.
    env.reset(seed=0, options={"layout": flat}); env.s, env.d, env.vx = 5.0, -6.0, 15.0
    for _ in range(5):
        _, _, _, _, info = env.step([0.2, 0.35])
    ay = env.v * abs(env.r)
    out["curva_g"], out["balanceo_deg"] = round(ay / env.p["gravity_mps2"], 2), round(abs(info["roll_deg"]), 2)
    out["peso_afuera"] = round(info["wheel_loads"][1] + info["wheel_loads"][3], 3)
    # 3) Caída desde un salto a 6 m/s: compresión máxima de la suspensión.
    env.reset(seed=0, options={"layout": flat}); env.s, env.vx = 5.0, 15.0
    events = []
    env.airborne, env.z, env.vz = True, 0.05, -6.0
    env._takeoff_z, env._from_deck = 1.0, False
    comp, dt = 0.0, env.p["dt_s"] / env.p["substeps"]
    for _ in range(40):
        env.bottomed = False
        env._substep(0.0, 0.0, dt, events)
        comp = max(comp, env.heave)
    out["aterrizaje_6mps_compresion_m"], out["aterrizaje_golpea_topes"] = round(comp, 3), "golpea_los_topes" in events or comp >= env.p["suspension_travel_m"] - 1e-6
    return out


# ---------------- evaluación común ----------------
def frame_of(info, reward, total, action):
    keep = ("s", "d", "x", "y", "z", "heading", "speed_mps", "speed_kmh", "vz", "airborne", "on_deck", "lane", "terrain_here",
            "fuel_l", "progress_pct", "checkpoints", "accidents", "steps", "termination_cause", "events", "poses", "jumps",
            "slip_deg", "steer_deg", "pedal", "yaw_rate", "wheelspin",
            "pitch_deg", "roll_deg", "heave_m", "wheel_loads", "wheel_lifted", "rear_slip_deg", "landing_vz")
    f = {k: info[k] for k in keep if k in info}
    f.update({"reward": round(float(reward), 4), "return": round(float(total), 3), "action": None if action is None else [round(float(a), 3) for a in action]})
    return f


def evaluate(policy_factory, config, layouts, perturbation=None, keep=(), seed=0):
    """Corre la política (sin exploración) una vez en cada pista de la suite.

    Además del éxito, mide el deslizamiento de la carrocería (grados entre hacia dónde apunta
    el coche y hacia dónde se mueve) en cada terreno (hipótesis del N5) y, nuevo en el N6, el
    cabeceo y el balanceo de la carrocería, las ruedas levantadas, los aterrizajes y la causa
    de cada accidente."""
    env = RallyV6Env(config, perturbation)
    rows, replays = [], {}
    slip_by_terrain, course_mud, lateral_mud = {}, [], []
    rolls, pitches, lifted, ground_steps, landings, bottomed = [], [], 0, 0, [], 0
    causes = {}
    crash_names = {"sale_de_la_pista", "hace_un_trompo", "choca_con_la_valla", "aterrizaje_duro", "cae_en_foso", "cae_del_puente",
                   "sale_volando_de_la_pista", "choca_con_el_borde_del_puente"}
    for i, layout in enumerate(layouts):
        policy = policy_factory(env)
        obs, info = env.reset(seed=seed + i, options={"layout": layout})
        total, frames = 0.0, [frame_of(info, 0, 0, None)] if i in keep else None
        while True:
            action = policy(obs)
            obs, reward, terminated, truncated, info = env.step(action)
            total += reward
            for ev in info["events"]:
                if ev in crash_names:
                    causes[ev] = causes.get(ev, 0) + 1
            if "golpea_los_topes" in info["events"]:
                bottomed += 1
            if info.get("landing_vz") is not None:
                landings.append(info["landing_vz"])
            if not info["airborne"] and info["speed_mps"] > 5:
                ground_steps += 1
                lifted += int(info["wheel_lifted"])
                rolls.append(abs(info["roll_deg"]))
                pitches.append(info["pitch_deg"])
            if not info["airborne"] and info["speed_mps"] > 2:
                slip_by_terrain.setdefault(info["terrain_here"], []).append(abs(info["slip_deg"]))
                if info["terrain_here"] == "lodo":
                    course = info["psi"] + math.radians(info["slip_deg"])     # ángulo de avance respecto a la pista
                    course_mud.append(abs(math.degrees(course)))
                    lateral_mud.append(abs(info["speed_mps"] * math.sin(course)))
            if frames is not None:
                frames.append(frame_of(info, reward, total, action))
            if terminated or truncated:
                break
        rows.append({"layout_seed": layout["seed"], "success": info["termination_cause"] == "vuelta_completada", "return": total,
                     "steps": info["steps"], "time_s": info["steps"] * env.p["dt_s"], "accidents": info["accidents"],
                     "checkpoints": info["checkpoints"], "progress_pct": info["progress_pct"], "fuel_l": info["fuel_l"],
                     "termination_cause": info["termination_cause"]})
        if frames is not None:
            replays[i] = {"layout": layout, "frames": frames}
    summary = {"success_rate": float(np.mean([r["success"] for r in rows])),
               "mean_return": float(np.mean([r["return"] for r in rows])),
               "mean_time_s_success": float(np.mean([r["time_s"] for r in rows if r["success"]])) if any(r["success"] for r in rows) else None,
               "mean_accidents": float(np.mean([r["accidents"] for r in rows])),
               "mean_progress_pct": float(np.mean([r["progress_pct"] for r in rows])),
               "mean_mud_slip_deg": float(np.mean(slip_by_terrain["lodo"])) if slip_by_terrain.get("lodo") else None,
               "mean_mud_course_deg": float(np.mean(course_mud)) if course_mud else None,
               "mean_mud_lateral_mps": float(np.mean(lateral_mud)) if lateral_mud else None,
               "p95_roll_deg": float(np.percentile(rolls, 95)) if rolls else None,
               "max_dive_deg": float(np.max(pitches)) if pitches else None,
               "wheel_lift_share": lifted / ground_steps if ground_steps else 0.0,
               "landings": len(landings), "mean_landing_vz": float(np.mean(landings)) if landings else None,
               "bottom_outs": bottomed, "accident_causes": causes}
    slip = {k: {"mean_deg": round(float(np.mean(v)), 3), "p95_deg": round(float(np.percentile(v, 95)), 3), "samples": len(v)}
            for k, v in sorted(slip_by_terrain.items())}
    return {"summary": summary, "slip_by_terrain": slip, "cases": rows, "replays": replays, "perturbation": perturbation}


# ---------------- PPO ----------------
def make_vec(config, seed, n_envs):
    from stable_baselines3.common.env_util import make_vec_env
    from stable_baselines3.common.vec_env import VecNormalize
    import os
    from stable_baselines3.common.vec_env import DummyVecEnv, SubprocVecEnv
    # Con varios núcleos, cada copia del ambiente corre en su propio proceso (mismo resultado, más rápido).
    cls = SubprocVecEnv if n_envs > 1 and (os.cpu_count() or 1) > 1 else DummyVecEnv
    venv = make_vec_env(lambda: RallyV6Env(config), n_envs=n_envs, seed=seed, vec_env_cls=cls)
    return VecNormalize(venv, norm_obs=True, norm_reward=True, clip_obs=10.0, gamma=config["training"]["ppo"]["gamma"])


def ppo_policy_factory(model, vecnorm):
    def factory(env):
        def act(obs):
            nobs = vecnorm.normalize_obs(obs[None, :])
            action, _ = model.predict(nobs, deterministic=True)
            return np.clip(action[0], -1, 1).astype(np.float32)
        return act
    return factory


def export_onnx(model, vecnorm, path, n_obs):
    """Red exportada con la normalización adentro: entra la observación cruda (146 números), sale [acelerador, giro]."""
    import torch

    policy = model.policy

    class Actor(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.features = policy.pi_features_extractor
            self.extractor = policy.mlp_extractor
            self.action_net = policy.action_net
            self.clip = float(vecnorm.clip_obs)
            self.register_buffer("mean", torch.tensor(vecnorm.obs_rms.mean, dtype=torch.float32))
            self.register_buffer("std", torch.tensor(np.sqrt(vecnorm.obs_rms.var + vecnorm.epsilon), dtype=torch.float32))

        def forward(self, obs):
            x = torch.clamp((obs - self.mean) / self.std, -self.clip, self.clip)
            latent = self.extractor.forward_actor(self.features(x))
            return torch.clamp(self.action_net(latent), -1.0, 1.0)

    actor = Actor().eval()
    dummy = torch.zeros((1, n_obs), dtype=torch.float32)
    with torch.no_grad():
        torch.onnx.export(actor, dummy, str(path), input_names=["observation"], output_names=["action"],
                          dynamic_axes={"observation": {0: "batch"}, "action": {0: "batch"}}, opset_version=17, dynamo=False)
    return actor


def verify_onnx(path, model, vecnorm, config, samples=200):
    """Comprueba que la red ONNX da las mismas acciones que SB3 en observaciones reales."""
    import onnxruntime as ort
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    env = RallyV6Env(config)
    obs, _ = env.reset(seed=123, options={"layout_seed": 999})
    batch, worst = [], 0.0
    for _ in range(samples):
        batch.append(obs)
        sb3_action = ppo_policy_factory(model, vecnorm)(env)(obs)
        onnx_action = sess.run(None, {"observation": obs[None, :].astype(np.float32)})[0][0]
        worst = max(worst, float(np.max(np.abs(sb3_action - onnx_action))))
        obs, _, te, tr, _ = env.step(sb3_action)
        if te or tr:
            obs, _ = env.reset()
    return worst


def train_ppo(config, seed, output_root=ROOT, eval_layouts=None, log=print):
    from stable_baselines3 import PPO
    from stable_baselines3.common.callbacks import BaseCallback
    import torch

    torch.set_num_threads(1)
    pc = config["training"]["ppo"]
    run_id = f"rally-v6-ppo-{uuid.uuid4().hex}"
    folder = Path(output_root) / "models" / run_id
    folder.mkdir(parents=True, exist_ok=False)
    venv = make_vec(config, seed, pc["n_envs"])
    lr0 = pc["learning_rate"]
    # Intento 2: la tasa de aprendizaje puede bajar en línea recta hasta 0 (evita "olvidar" al final).
    learning_rate = (lambda progress_remaining: lr0 * progress_remaining) if pc.get("lr_schedule") == "linear" else lr0
    model = PPO("MlpPolicy", venv, seed=seed, n_steps=pc["n_steps"], batch_size=pc["batch_size"], n_epochs=pc["n_epochs"],
                learning_rate=learning_rate, gamma=pc["gamma"], gae_lambda=pc["gae_lambda"], clip_range=pc["clip_range"],
                ent_coef=pc["ent_coef"], use_sde=pc.get("use_sde", False), sde_sample_freq=pc.get("sde_sample_freq", -1),
                policy_kwargs={"net_arch": pc["net_arch"], "log_std_init": pc["log_std_init"]}, verbose=0, device="cpu")
    probe = eval_layouts[: pc["eval_layouts_during_training"]] if eval_layouts else evaluation_layouts(config, pc["eval_layouts_during_training"])
    valid = validation_layouts(config)
    best = {"score": None, "timesteps": None, "path": folder / "_mejor_punto.zip", "obs_rms": None}
    train_curve, eval_curve = [], []

    class Curves(BaseCallback):
        """Guarda las dos curvas que pide la guía: entrenamiento (con exploración) y evaluación (sin exploración)."""
        def __init__(self):
            super().__init__()
            self.ep_returns, self.ep_success, self.next_eval = [], [], 0

        def _on_step(self):
            for info in self.locals["infos"]:
                if "episode" in info:
                    self.ep_returns.append(info["episode"]["r"])
                    self.ep_success.append(info.get("termination_cause") == "vuelta_completada")
            if self.num_timesteps >= self.next_eval:
                self.next_eval += pc["eval_every_steps"]
                if self.ep_returns:
                    train_curve.append({"timesteps": int(self.num_timesteps), "mean_return": float(np.mean(self.ep_returns[-50:])),
                                        "success_rate": float(np.mean(self.ep_success[-50:]))})
                venv.training = False
                res = evaluate(ppo_policy_factory(model, venv), config, probe, seed=seed)
                point = {"timesteps": int(self.num_timesteps), **res["summary"]}
                extra = ""
                if valid:
                    vres = evaluate(ppo_policy_factory(model, venv), config, valid, seed=seed)["summary"]
                    point.update({"validation_success_rate": vres["success_rate"], "validation_progress_pct": vres["mean_progress_pct"]})
                    if best["score"] is None or score_of(vres) > best["score"]:
                        best.update(score=score_of(vres), timesteps=int(self.num_timesteps), obs_rms=copy.deepcopy(venv.obs_rms))
                        model.save(best["path"])
                        extra = " · ★ mejor en validación"
                    extra = f" · validación {vres['success_rate']:.0%}" + extra
                venv.training = True
                eval_curve.append(point)
                log(f"   PPO semilla {seed} · {self.num_timesteps:>7} pasos · éxito {res['summary']['success_rate']:.0%} · retorno {res['summary']['mean_return']:.1f}{extra}")
            return True

    start = time.time()
    model.learn(total_timesteps=pc["total_timesteps"], callback=Curves(), progress_bar=False)
    train_seconds = time.time() - start
    venv.training = False
    chosen = {"rule": "final", "timesteps": int(model.num_timesteps)}
    if best["score"] is not None:
        # Nos quedamos con el punto del entrenamiento que mejor manejó en las pistas de validación.
        model.set_parameters(str(best["path"]), exact_match=True, device="cpu")
        venv.obs_rms = best["obs_rms"]
        best["path"].unlink()
        chosen = {"rule": "mejor_en_validacion", "timesteps": best["timesteps"], "validation_layouts": len(valid),
                  "validation_layout_seed_offset": config["training"].get("validation_layout_seed_offset", 200000)}
    model.save(folder / "model.zip")
    venv.save(str(folder / "vecnormalize.pkl"))
    n_obs = RallyV6Env(config).observation_space.shape[0]
    write_json(folder / "normalization.json", {"type": "VecNormalize (media y varianza móviles)", "mean": venv.obs_rms.mean.tolist(),
                                               "var": venv.obs_rms.var.tolist(), "epsilon": venv.epsilon, "clip_obs": venv.clip_obs,
                                               "formula": "obs_normalizada = clip((obs - mean) / sqrt(var + epsilon), -clip_obs, clip_obs)"})
    export_onnx(model, venv, folder / "policy.onnx", n_obs)
    onnx_error = verify_onnx(folder / "policy.onnx", model, venv, config)
    log(f"   ONNX verificado: diferencia máxima con SB3 = {onnx_error:.2e}")
    return {"algorithm": "ppo", "run_id": run_id, "seed": seed, "folder": folder, "model": model, "vecnorm": venv,
            "policy_factory": ppo_policy_factory(model, venv), "train_curve": train_curve, "eval_curve": eval_curve,
            "train_seconds": train_seconds, "timesteps": int(model.num_timesteps), "onnx_max_abs_error": onnx_error, "chosen_checkpoint": chosen}


# ---------------- Q-learning ----------------
def train_qlearning(config, seed, output_root=ROOT, eval_layouts=None, log=print):
    qc = config["training"]["qlearning"]
    run_id = f"rally-v6-qlearning-{uuid.uuid4().hex}"
    folder = Path(output_root) / "models" / run_id
    folder.mkdir(parents=True, exist_ok=False)
    env = DiscreteRallyV6(RallyV6Env(config))
    rng = np.random.default_rng(seed)
    q = np.zeros((env.observation_space.n, env.action_space.n))
    train_curve, eval_curve, returns, success, steps_total = [], [], [], [], 0
    probe = eval_layouts[: config["training"]["ppo"]["eval_layouts_during_training"]] if eval_layouts else evaluation_layouts(config, 5)
    budget = config["training"]["ppo"]["total_timesteps"]   # mismo presupuesto de pasos que PPO
    every = max(1, budget // 12)
    next_eval, ep = every, 0
    valid = validation_layouts(config)
    best_score, best_q, best_steps = None, None, None
    start = time.time()
    while steps_total < budget:
        ep += 1
        eps = qc["epsilon_start"] + (qc["epsilon_end"] - qc["epsilon_start"]) * min(1.0, steps_total / budget)
        state, info = env.reset(seed=seed * 100000 + ep)
        total = 0.0
        while True:
            a = int(rng.integers(env.action_space.n)) if rng.random() < eps else int(rng.choice(np.flatnonzero(q[state] == q[state].max())))
            nxt, r, te, tr, info = env.step(a)
            target = r if te else r + qc["gamma"] * q[nxt].max()
            q[state, a] += qc["alpha"] * (target - q[state, a])
            state, total, steps_total = nxt, total + r, steps_total + 1
            if te or tr:
                break
        returns.append(total)
        success.append(info["termination_cause"] == "vuelta_completada")
        if steps_total >= next_eval or steps_total >= budget:
            next_eval += every
            train_curve.append({"timesteps": steps_total, "mean_return": float(np.mean(returns[-50:])), "success_rate": float(np.mean(success[-50:]))})
            res = evaluate(q_policy_factory(q), config, probe, seed=seed)
            point, extra = {"timesteps": steps_total, **res["summary"]}, ""
            if valid:
                vres = evaluate(q_policy_factory(q), config, valid, seed=seed)["summary"]
                point.update({"validation_success_rate": vres["success_rate"], "validation_progress_pct": vres["mean_progress_pct"]})
                if best_score is None or score_of(vres) > best_score:
                    best_score, best_q, best_steps, extra = score_of(vres), q.copy(), steps_total, " · ★ mejor en validación"
                extra = f" · validación {vres['success_rate']:.0%}" + extra
            eval_curve.append(point)
            log(f"   Q-learning semilla {seed} · {steps_total:>7} pasos · éxito {res['summary']['success_rate']:.0%} · retorno {res['summary']['mean_return']:.1f}{extra}")
    chosen = {"rule": "final", "timesteps": steps_total}
    if best_q is not None:
        q = best_q
        chosen = {"rule": "mejor_en_validacion", "timesteps": best_steps, "validation_layouts": len(valid),
                  "validation_layout_seed_offset": config["training"].get("validation_layout_seed_offset", 200000)}
    np.save(folder / "q_table.npy", q, allow_pickle=False)
    return {"algorithm": "qlearning", "run_id": run_id, "seed": seed, "folder": folder, "q": q,
            "policy_factory": q_policy_factory(q), "train_curve": train_curve, "eval_curve": eval_curve,
            "train_seconds": time.time() - start, "timesteps": steps_total, "chosen_checkpoint": chosen}


def q_policy_factory(q):
    def factory(env):
        wrapper = DiscreteRallyV6(env)
        return lambda obs: wrapper.to_continuous(int(np.argmax(q[wrapper.encode()])))
    return factory


# ---------------- paquete del modelo ----------------
def package(result, config, evaluations, extra=None):
    """Escribe config, métricas, evaluación por caso, manifiesto y ficha (sección 11 de la guía)."""
    folder = result["folder"]
    write_json(folder / "config.json", config)
    write_json(folder / "training_curves.json", {"entrenamiento_con_exploracion": result["train_curve"], "evaluacion_sin_exploracion": result["eval_curve"]})
    write_json(folder / "evaluation.json", {"suite": EVALUATION_SUITE_ID, **{k: {"summary": v["summary"], "slip_by_terrain": v.get("slip_by_terrain"), "cases": v["cases"]} for k, v in evaluations.items()}})
    env = RallyV6Env(config)
    weights = folder / ("model.zip" if result["algorithm"] == "ppo" else "q_table.npy")
    sources = {name: digest(ROOT / name) for name in SOURCE_FILES if (ROOT / name).exists()}
    contract = {"observation": {"shape": list(env.observation_space.shape), "dtype": "float32",
                                "order": list(env.BASE_OBS) + [f"carril{l}_celda{c}_{f}" for l in range(env.lanes) for c in range(env.look) for f in config["sensors"]["features_per_cell"]],
                                "units": "ver docs/rally-v6.md (velocidad/35 m/s, posición lateral/8 m, altura/4 m, velocidad lateral/5 m/s, giro/1 rad/s, volante/0,40 rad, deslizamiento/0,5 rad, agarre 0-1, peso adelante y afuera en -1..1, cabeceo/0,05 rad, balanceo/0,08 rad, compresión/0,30 m, deslizamiento trasero/0,15 rad, sensores 0-1)", "clipping": [-5, 5]},
                "action": {"shape": [2], "order": ["acelerador(+)/freno(-)", "giro(+ izquierda)"], "range": [-1, 1],
                           "units": "orden de pedal: fracción de 6 m/s² (acelerar) o 9 m/s² (frenar), el pedal real llega en 0,2 s; fracción de 0,40 rad de volante (orden: el volante real gira a 1,2 rad/s como máximo)"}}
    if result["algorithm"] == "qlearning":
        contract["discretization"] = {"states": 720, "actions": 15, "throttle": list(DiscreteRallyV6.THROTTLE), "steer": list(DiscreteRallyV6.STEER),
                                      "speed_bins_mps": config["training"]["qlearning"]["speed_bins"], "psi_bins_rad": config["training"]["qlearning"]["psi_bins"],
                                      "perdida_de_resolucion": "no ve la posición exacta en el carril, ni los otros carriles, ni la curvatura; el giro solo tiene 5 valores"}
    files = {p.name: digest(p) for p in sorted(folder.iterdir()) if p.is_file() and p.name not in ("manifest.json", "metadata.json")}
    manifest = {"run_id": result["run_id"], "level_id": config["level_id"], "environment_version": config["environment_version"],
                "algorithm": result["algorithm"], "git_commit": git_head(), "config_sha256": digest(folder / "config.json"),
                "model_uri": f"models/{result['run_id']}/{weights.name}", "model_sha256": digest(weights),
                "normalization_uri": f"models/{result['run_id']}/normalization.json" if result["algorithm"] == "ppo" else None,
                "browser_model_uri": f"models/{result['run_id']}/policy.onnx" if result["algorithm"] == "ppo" else None,
                "runtime_ref": "requirements.txt (torch, stable-baselines3, gymnasium) + race_env_v6.py en el commit indicado",
                "evaluation_suite_id": EVALUATION_SUITE_ID, "seed": result["seed"], "parent_run_id": None, "training_origin": "desde_cero",
                "budget": {"timesteps": result["timesteps"], "train_seconds": round(result["train_seconds"], 1)},
                "chosen_checkpoint": result.get("chosen_checkpoint"),
                "optimizer_state": "incluido en model.zip (Adam), se puede continuar con PPO.load(...).learn()" if result["algorithm"] == "ppo" else None,
                "contract": contract, "files_sha256": files, "source_sha256": sources, **(extra or {})}
    write_json(folder / "manifest.json", manifest)
    algo = "PPO (Stable-Baselines3, red 64×64)" if result["algorithm"] == "ppo" else "Q-learning tabular discretizado (720×15)"
    (folder / "README.md").write_text(
        f"---\ntags:\n- reinforcement-learning\n- {result['algorithm']}\n- gymnasium\n---\n\n# Autonomous Rally N6 · {algo}\n\n"
        f"Semilla {result['seed']}, {result['timesteps']} pasos de entrenamiento. Evaluación en la suite `{EVALUATION_SUITE_ID}` "
        f"(30 pistas nunca vistas): éxito {evaluations['normal']['summary']['success_rate']:.0%}.\n\n"
        + ("Cargar: `PPO.load('model.zip')` + `VecNormalize.load('vecnormalize.pkl', venv)`; o en el navegador `policy.onnx` "
           "(ya incluye la normalización: entra la observación cruda de 146 números, sale [acelerador, giro]).\n"
           if result["algorithm"] == "ppo" else "Cargar con `numpy.load('q_table.npy')`; ver `contract.discretization` en manifest.json.\n")
        + "\nContrato completo de entrada y salida en `manifest.json`.\n", encoding="utf-8")
    return manifest


def write_eval_csv(path, evaluations):
    """Dataset versionado con DVC: una fila por (condición, pista) con el resultado."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        fields = ["condition", "layout_seed", "success", "return", "steps", "time_s", "accidents", "checkpoints", "progress_pct", "fuel_l", "termination_cause"]
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for cond, ev in evaluations.items():
            for row in ev["cases"]:
                w.writerow({"condition": cond, **row})
