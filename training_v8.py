"""N8 · "Superar al maestro": el mismo coche y la misma pista del N7, pero se reestructura CÓMO se entrena.

Qué es cada cosa (glosario corto, el largo está en docs/rally-v8.md):
  * PASO: una decisión de la IA (mira los 250 sensores y elige pedal y volante). Dura 0,25 s de carrera.
  * EPISODIO: una carrera completa, de la salida hasta que termina por una de 5 causas:
    vuelta completa, 5 accidentes, atascado (10 s sin avanzar), límite de pasos o corte de entrenamiento.
  * MODELO: red neuronal (perceptrón multicapa, 2 capas de 256 neuronas) con dos "cabezas":
    el actor decide la acción y el crítico estima qué tan bien va la carrera.

Estructura nueva del entrenamiento (todo se configura en configs/rally-v8.json):
  1. IMITACIÓN (DAgger) con PARADA TEMPRANA: hasta 14 rondas; se detiene sola si la nota en las pistas
     de validación no mejora durante 4 rondas seguidas, y se queda con la mejor ronda.
  2. PRÁCTICA (PPO) con PARADA TEMPRANA: hasta 2 millones de pasos; cada 100 mil pasos se examina en 30
     pistas de validación y, si lleva 8 exámenes seguidos sin mejorar, el entrenamiento se detiene.
  3. Practica también con lluvia y con sensores con ruido (antes solo con buen clima).
  4. CORTE de episodios: en el entrenamiento una carrera se corta a los 100 s (400 pasos); una vuelta normal
     toma 70 s, así que lo que pasa después casi nunca enseña nada y gasta pasos.
  5. LIBRO DE EPISODIOS: se cuenta cada episodio y cómo terminó, en cada fase.
  6. La nota para elegir el mejor punto ya no es solo "llegó a la meta": primero vueltas LIMPIAS (sin ningún
     accidente), después vueltas completas y después el tiempo de vuelta.

La recompensa v8 usa los mismos términos que la v5 con tres números distintos: cada paso cuesta 0,1 (antes
0,02: ahora el tiempo importa), cada accidente cuesta 10 (antes 5) y no hay premio por combustible sobrante.
"""
from __future__ import annotations

import copy
import time
import uuid
from pathlib import Path

import gymnasium as gym
import numpy as np

from race_env_v7 import RallyV7Env, generate_layout
import training_v7 as T7
from training_v7 import (ROOT, FrozenRMS, evaluate, evaluation_layouts, export_onnx, ppo_policy_factory, rule_policy,
                         validation_layouts, verify_onnx, write_json)

SOURCE_FILES = ("race_env_v7.py", "race_env_v8.py", "training_v7.py", "training_v8.py", "pipeline_v8.py", "configs/rally-v8.json")
EVALUATION_SUITE_ID = "rally-v7-suite-1"   # las mismas 30 pistas del N4 al N7
CAUSES = ("vuelta_completada", "demasiados_accidentes", "atascado", "limite_pasos", "corte_de_entrenamiento")


# ---------------- nota de una evaluación ----------------
def add_clean_stats(ev):
    """Agrega al resumen las vueltas LIMPIAS (completas y sin ningún accidente) y el tiempo de esas vueltas."""
    cases = ev["cases"]
    clean = [c for c in cases if c["success"] and c["accidents"] == 0]
    ev["summary"]["clean_rate"] = len(clean) / len(cases)
    ev["summary"]["mean_time_s_clean"] = float(np.mean([c["time_s"] for c in clean])) if clean else None
    ev["summary"]["best_time_s"] = float(min(c["time_s"] for c in cases if c["success"])) if any(c["success"] for c in cases) else None
    return ev


def evaluate_v8(policy_factory, config, layouts, perturbation=None, keep=(), seed=0):
    return add_clean_stats(evaluate(policy_factory, config, layouts, perturbation=perturbation, keep=keep, seed=seed))


def score_v8(summary):
    """Orden para elegir el mejor punto: vueltas limpias, vueltas completas, tiempo de vuelta (menos es mejor), avance."""
    t = summary["mean_time_s_success"]
    return (round(summary["clean_rate"], 6), round(summary["success_rate"], 6), -(t if t is not None else 1e9), summary["mean_progress_pct"])


def improved(new, old, min_time_gain_s=0.25):
    """¿La nota nueva es mejor que la anterior? Una mejora de tiempo de menos de 0,25 s no cuenta (es ruido)."""
    if old is None:
        return True
    if new[:2] != old[:2]:
        return new[:2] > old[:2]
    return new[2] - old[2] >= min_time_gain_s


# ---------------- libro de episodios ----------------
class Ledger:
    """Cuenta cada episodio de entrenamiento: en qué fase ocurrió, cuántos pasos duró y cómo terminó."""
    def __init__(self):
        self.phases = {}

    def add(self, phase, steps, cause):
        p = self.phases.setdefault(phase, {"episodes": 0, "steps": 0, "by_cause": {c: 0 for c in CAUSES}})
        p["episodes"] += 1
        p["steps"] += int(steps)
        p["by_cause"][cause] = p["by_cause"].get(cause, 0) + 1

    def as_dict(self):
        out = {k: {**v, "mean_steps_per_episode": round(v["steps"] / v["episodes"], 1) if v["episodes"] else None} for k, v in self.phases.items()}
        out["total"] = {"episodes": sum(v["episodes"] for v in self.phases.values()), "steps": sum(v["steps"] for v in self.phases.values()),
                        "by_cause": {c: sum(v["by_cause"].get(c, 0) for v in self.phases.values()) for c in CAUSES}}
        return out


class TrainingCut(gym.Wrapper):
    """Solo para ENTRENAR: corta la carrera a los `cut_steps` pasos. No cambia el examen (que sigue con 600)."""
    def __init__(self, env, cut_steps):
        super().__init__(env)
        self.cut_steps = cut_steps

    def step(self, action):
        obs, reward, terminated, truncated, info = self.env.step(action)
        if not terminated and not truncated and info["steps"] >= self.cut_steps:
            truncated = True
            info["termination_cause"] = "corte_de_entrenamiento"
        return obs, reward, terminated, truncated, info


# ---------------- 1. imitación con parada temprana ----------------
def imitate_rules(model, venv, config, seed, valid, ledger, log=print):
    """DAgger (Ross et al., 2011) como en el N7, con tres cambios: practica también con lluvia, se detiene sola
    cuando deja de mejorar (parada temprana) y devuelve la MEJOR ronda, no la última."""
    import torch
    ic = config["training"]["imitation"]
    conditions = ic.get("conditions", ["normal"])
    envs = {c: RallyV7Env(config, None if c == "normal" else c) for c in set(conditions)}
    policy = model.policy
    actor_params = list(policy.mlp_extractor.policy_net.parameters()) + list(policy.action_net.parameters())
    torch.manual_seed(seed)
    X, Y, curve, env_steps, episodes = [], [], [], 0, 0
    layout_seed = ic["layout_seed_offset"] + seed * 10000          # pistas de entrenamiento: nunca las del examen ni las de validación
    best = {"score": None, "round": None, "state": None, "rms": None}
    stale, stopped_early = 0, False

    def actor_mean(obs_t):
        return policy.action_net(policy.mlp_extractor.forward_actor(policy.extract_features(obs_t)))

    def student(obs):
        with torch.no_grad():
            x = torch.as_tensor(venv.normalize_obs(obs[None, :]), dtype=torch.float32)
            return np.clip(actor_mean(x)[0].numpy(), -1, 1).astype(np.float32)

    for rnd in range(ic["max_rounds"]):
        finished = 0
        for k in range(ic["episodes_per_round"]):
            cond = conditions[k % len(conditions)]
            env = envs[cond]
            obs, info = env.reset(seed=layout_seed, options={"layout": generate_layout(config, layout_seed)})
            layout_seed += 1
            teacher = rule_policy(env)
            while True:
                wanted = teacher(obs)                               # lo que haría el maestro aquí
                X.append(obs.copy()); Y.append(wanted)
                obs, _, terminated, truncated, info = env.step(wanted if rnd == 0 else student(obs))
                env_steps += 1
                if terminated or truncated:
                    break
            episodes += 1
            ledger.add("imitacion", info["steps"], info["termination_cause"])
            finished += info["termination_cause"] == "vuelta_completada"
        x = np.asarray(X, np.float32)
        venv.obs_rms = FrozenRMS(x.mean(0), x.var(0), len(x))
        xn = torch.as_tensor(venv.normalize_obs(x), dtype=torch.float32)
        y = torch.as_tensor(np.asarray(Y, np.float32))
        opt = torch.optim.Adam(actor_params, ic["learning_rate"])
        sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, ic["epochs"])
        for _ in range(ic["epochs"]):
            perm, total = torch.randperm(len(xn)), 0.0
            for i in range(0, len(xn), ic["batch_size"]):
                idx = perm[i:i + ic["batch_size"]]
                loss = torch.nn.functional.smooth_l1_loss(actor_mean(xn[idx]), y[idx], beta=0.05)
                opt.zero_grad(); loss.backward(); opt.step()
                total += loss.item() * len(idx)
            sched.step()
        v = evaluate_v8(lambda e: student, config, valid, seed=seed)["summary"]
        point = {"round": rnd, "samples": len(X), "env_steps": env_steps, "episodes": episodes, "driver": "maestro" if rnd == 0 else "alumno",
                 "laps_while_collecting": finished / ic["episodes_per_round"], "loss": total / len(xn),
                 "validation_success_rate": v["success_rate"], "validation_clean_rate": v["clean_rate"],
                 "validation_time_s": v["mean_time_s_success"], "validation_progress_pct": v["mean_progress_pct"]}
        star = ""
        if improved(score_v8(v), best["score"]):
            best.update(score=score_v8(v), round=rnd, state=copy.deepcopy(policy.state_dict()), rms=venv.obs_rms.copy())
            stale, star = 0, " · ★ mejor ronda"
        else:
            stale += 1
        point["best_so_far"] = bool(star)
        curve.append(point)
        log(f"   Imitación semilla {seed} · ronda {rnd} ({point['driver']} al volante) · {len(X)} ejemplos · "
            f"validación: limpias {v['clean_rate']:.0%}, completas {v['success_rate']:.0%}{star}")
        if rnd + 1 >= ic["min_rounds"] and stale >= ic["patience_rounds"]:
            stopped_early = True
            log(f"   Parada temprana de la imitación: {stale} rondas seguidas sin mejorar. Se usa la ronda {best['round']}.")
            break
    policy.load_state_dict(best["state"])
    venv.obs_rms = best["rms"]
    return {"curve": curve, "env_steps": env_steps, "episodes": episodes, "samples": len(X), "rounds_run": len(curve),
            "max_rounds": ic["max_rounds"], "best_round": best["round"], "stopped_early": stopped_early,
            "patience_rounds": ic["patience_rounds"]}


# ---------------- 2. práctica con PPO y parada temprana ----------------
def make_vec(config, seed):
    """Varias copias del ambiente a la vez. `env_mix` dice cuántas con buen clima, con lluvia y con sensores con ruido."""
    import os
    from stable_baselines3.common.monitor import Monitor
    from stable_baselines3.common.vec_env import DummyVecEnv, SubprocVecEnv, VecNormalize
    pc = config["training"]["ppo"]
    conds = [c for c, n in pc["env_mix"].items() for _ in range(n)]

    def maker(cond, i):
        def make():
            env = RallyV7Env(config, None if cond == "normal" else cond)
            if pc.get("episode_cut_steps"):
                env = TrainingCut(env, pc["episode_cut_steps"])
            env = Monitor(env)
            env.reset(seed=seed + i)
            return env
        return make

    fns = [maker(c, i) for i, c in enumerate(conds)]
    venv = (SubprocVecEnv if len(fns) > 1 and (os.cpu_count() or 1) > 1 else DummyVecEnv)(fns)
    venv.seed(seed)
    return VecNormalize(venv, norm_obs=True, norm_reward=True, clip_obs=10.0, gamma=pc["gamma"]), conds


def train_ppo(config, seed, output_root=ROOT, log=print):
    from stable_baselines3 import PPO
    from stable_baselines3.common.callbacks import BaseCallback
    import torch

    torch.set_num_threads(1)
    pc = config["training"]["ppo"]
    run_id = f"rally-v8-ppo-{uuid.uuid4().hex}"
    folder = Path(output_root) / "models" / run_id
    folder.mkdir(parents=True, exist_ok=False)
    venv, conds = make_vec(config, seed)
    lr0 = pc["learning_rate"]
    learning_rate = (lambda progress_remaining: lr0 * max(progress_remaining, pc.get("lr_floor_fraction", 0.1))) if pc.get("lr_schedule") == "linear" else lr0
    model = PPO("MlpPolicy", venv, seed=seed, n_steps=pc["n_steps"], batch_size=pc["batch_size"], n_epochs=pc["n_epochs"],
                learning_rate=learning_rate, gamma=pc["gamma"], gae_lambda=pc["gae_lambda"], clip_range=pc["clip_range"],
                ent_coef=pc["ent_coef"], target_kl=pc.get("target_kl"),
                policy_kwargs={"net_arch": pc["net_arch"], "log_std_init": pc["log_std_init"], "ortho_init": pc.get("ortho_init", False)},
                verbose=0, device="cpu")
    valid = validation_layouts(config)
    ledger = Ledger()
    best = {"score": None, "timesteps": None, "path": folder / "_mejor_punto.zip"}
    train_curve, eval_curve = [], []

    torch.set_num_threads(max(1, min(4, __import__('os').cpu_count() or 1)))   # la imitación es puro cálculo de la red: usa todos los núcleos
    imitation = imitate_rules(model, venv, config, seed, valid, ledger, log)
    torch.set_num_threads(1)                                                    # en PPO los núcleos son para las copias del ambiente
    frozen_policy, frozen_rms = copy.deepcopy(model.policy), venv.obs_rms.copy()

    def imitation_factory(env):
        def act(obs):
            nobs = np.clip((obs[None, :] - frozen_rms.mean) / np.sqrt(frozen_rms.var + venv.epsilon), -venv.clip_obs, venv.clip_obs)
            action, _ = frozen_policy.predict(nobs.astype(np.float32), deterministic=True)
            return np.clip(action[0], -1, 1).astype(np.float32)
        return act

    actor_params = [*model.policy.mlp_extractor.policy_net.parameters(), *model.policy.action_net.parameters(), model.policy.log_std]
    warmup = pc.get("critic_warmup_steps", 0)
    for prm in actor_params:
        prm.requires_grad_(warmup == 0)
    stop = {"early": False, "stale": 0, "reason": "se agotó el presupuesto de pasos"}

    class Curves(BaseCallback):
        def __init__(self):
            super().__init__()
            self.ep_returns, self.ep_success, self.ep_clean, self.next_eval = [], [], [], 0

        def _on_rollout_start(self):
            if warmup and self.num_timesteps >= warmup:
                for prm in actor_params:
                    prm.requires_grad_(True)

        def _on_step(self):
            for info in self.locals["infos"]:
                if "episode" in info:
                    cause = info.get("termination_cause", "limite_pasos")
                    ledger.add("practica_ppo", info["episode"]["l"], cause)
                    self.ep_returns.append(info["episode"]["r"])
                    self.ep_success.append(cause == "vuelta_completada")
                    self.ep_clean.append(cause == "vuelta_completada" and info.get("accidents", 1) == 0)
            if self.num_timesteps < self.next_eval:
                return True
            self.next_eval += pc["eval_every_steps"]
            done = ledger.phases.get("practica_ppo", {"episodes": 0})["episodes"]
            if self.ep_returns:
                train_curve.append({"timesteps": int(self.num_timesteps), "episodes": done, "mean_return": float(np.mean(self.ep_returns[-100:])),
                                    "success_rate": float(np.mean(self.ep_success[-100:])), "clean_rate": float(np.mean(self.ep_clean[-100:]))})
            v = evaluate_v8(ppo_policy_factory(model, venv), config, valid, seed=seed)["summary"]
            point = {"timesteps": int(self.num_timesteps), "episodes": done, "validation_success_rate": v["success_rate"],
                     "validation_clean_rate": v["clean_rate"], "validation_time_s": v["mean_time_s_success"],
                     "validation_progress_pct": v["mean_progress_pct"], "validation_accidents": v["mean_accidents"],
                     "success_rate": v["success_rate"], "mean_return": v["mean_return"]}
            star = ""
            if improved(score_v8(v), best["score"]):
                best.update(score=score_v8(v), timesteps=int(self.num_timesteps))
                model.save(best["path"])
                stop["stale"], star = 0, " · ★ mejor"
            else:
                stop["stale"] += 1
            point["best_so_far"] = bool(star)
            eval_curve.append(point)
            t = f"{v['mean_time_s_success']:.1f} s" if v["mean_time_s_success"] else "—"
            log(f"   PPO semilla {seed} · {self.num_timesteps:>7} pasos · {done:>5} episodios · validación: limpias {v['clean_rate']:.0%}, "
                f"completas {v['success_rate']:.0%}, vuelta {t}{star}")
            if self.num_timesteps >= pc["min_timesteps"] and stop["stale"] >= pc["patience_evals"]:
                stop.update(early=True, reason=f"{stop['stale']} exámenes de validación seguidos sin mejorar")
                log(f"   Parada temprana de PPO a los {self.num_timesteps} pasos: {stop['reason']}.")
                return False
            return True

    start = time.time()
    model.learn(total_timesteps=pc["total_timesteps"], callback=Curves(), progress_bar=False)
    train_seconds = time.time() - start
    venv.training = False
    model.set_parameters(str(best["path"]), exact_match=True, device="cpu")
    best["path"].unlink()
    chosen = {"rule": "mejor_en_validacion", "timesteps": best["timesteps"], "validation_layouts": len(valid),
              "validation_layout_seed_offset": config["training"].get("validation_layout_seed_offset", 200000),
              "score_order": ["vueltas limpias", "vueltas completas", "tiempo de vuelta", "avance"]}
    early = {"stopped_early": stop["early"], "reason": stop["reason"], "timesteps_run": int(model.num_timesteps),
             "timesteps_budget": pc["total_timesteps"], "patience_evals": pc["patience_evals"], "min_timesteps": pc["min_timesteps"],
             "steps_saved": max(0, int(pc["total_timesteps"] - model.num_timesteps))}
    model.save(folder / "model.zip")
    venv.save(str(folder / "vecnormalize.pkl"))
    n_obs = RallyV7Env(config).observation_space.shape[0]
    write_json(folder / "normalization.json", {"type": "media y varianza fijas, calculadas con los datos de la imitación",
                                               "mean": venv.obs_rms.mean.tolist(), "var": venv.obs_rms.var.tolist(), "epsilon": venv.epsilon,
                                               "clip_obs": venv.clip_obs,
                                               "formula": "obs_normalizada = clip((obs - mean) / sqrt(var + epsilon), -clip_obs, clip_obs)"})
    export_onnx(model, venv, folder / "policy.onnx", n_obs)
    onnx_error = verify_onnx(folder / "policy.onnx", model, venv, config)
    log(f"   ONNX verificado: diferencia máxima con SB3 = {onnx_error:.2e}")
    for prm in actor_params:
        prm.requires_grad_(True)
    venv.venv.close() if hasattr(venv.venv, "close") and len(conds) > 1 else None
    plain = {"algorithm": "ppo", "run_id": run_id, "seed": seed, "imitation": imitation,
             "train_curve": train_curve, "eval_curve": eval_curve, "train_seconds": train_seconds,
             "timesteps": int(model.num_timesteps) + imitation["env_steps"], "ppo_timesteps": int(model.num_timesteps),
             "onnx_max_abs_error": onnx_error, "chosen_checkpoint": chosen, "early_stopping": early, "episodes": ledger.as_dict(),
             "env_mix": pc["env_mix"]}
    # Se guarda todo lo necesario para no repetir el entrenamiento si el pipeline se corre por partes (una semilla a la vez).
    cache = _cache_dir(output_root, seed)
    cache.mkdir(parents=True, exist_ok=True)
    torch.save({"policy": frozen_policy.state_dict(), "mean": frozen_rms.mean, "var": frozen_rms.var, "count": frozen_rms.count}, cache / "imitacion.pt")
    write_json(cache / "resultado.json", {**plain, "folder": str(folder)})
    return {**plain, "folder": folder, "model": model, "vecnorm": venv, "imitation_policy_factory": imitation_factory,
            "policy_factory": ppo_policy_factory(model, venv)}


def _cache_dir(output_root, seed):
    return Path(output_root) / "entrenados-v8" / f"semilla-{seed}"


def load_trained(config, seed, output_root=ROOT):
    """Si esta semilla ya se entrenó (train_ppo dejó su carpeta), la carga sin volver a entrenar. Si no, devuelve None."""
    import json
    import torch
    from stable_baselines3 import PPO
    from stable_baselines3.common.vec_env import DummyVecEnv, VecNormalize
    cache = _cache_dir(output_root, seed)
    if not (cache / "resultado.json").exists():
        return None
    plain = json.loads((cache / "resultado.json").read_text(encoding="utf-8"))
    folder = Path(plain["folder"])
    venv = VecNormalize.load(str(folder / "vecnormalize.pkl"), DummyVecEnv([lambda: RallyV7Env(config)]))
    venv.training = False
    model = PPO.load(folder / "model.zip", device="cpu")
    saved = torch.load(cache / "imitacion.pt", weights_only=False)
    frozen_policy = copy.deepcopy(model.policy)
    frozen_policy.load_state_dict(saved["policy"])
    mean, var = saved["mean"], saved["var"]

    def imitation_factory(env):
        def act(obs):
            nobs = np.clip((obs[None, :] - mean) / np.sqrt(var + venv.epsilon), -venv.clip_obs, venv.clip_obs)
            action, _ = frozen_policy.predict(nobs.astype(np.float32), deterministic=True)
            return np.clip(action[0], -1, 1).astype(np.float32)
        return act
    return {**plain, "folder": folder, "model": model, "vecnorm": venv, "imitation_policy_factory": imitation_factory,
            "policy_factory": ppo_policy_factory(model, venv)}


# ---------------- modelo anterior (N7) como referencia en la web ----------------
def packaged_policy_factory(folder):
    """Carga un modelo ya publicado (model.zip + normalization.json) para correrlo en las mismas pistas."""
    import json
    from stable_baselines3 import PPO
    folder = Path(folder)
    model = PPO.load(folder / "model.zip", device="cpu")
    norm = json.loads((folder / "normalization.json").read_text(encoding="utf-8"))
    mean, var = np.asarray(norm["mean"]), np.asarray(norm["var"])

    def factory(env):
        def act(obs):
            nobs = np.clip((obs[None, :] - mean) / np.sqrt(var + norm["epsilon"]), -norm["clip_obs"], norm["clip_obs"])
            action, _ = model.predict(nobs.astype(np.float32), deterministic=True)
            return np.clip(action[0], -1, 1).astype(np.float32)
        return act
    return factory


# ---------------- paquete del modelo ----------------
def package(result, config, evaluations):
    T7.SOURCE_FILES, old = SOURCE_FILES, T7.SOURCE_FILES
    try:
        manifest = T7.package(result, config, evaluations, extra={
            "training_origin": "imitación de las reglas (DAgger) + práctica con PPO",
            "runtime_ref": "requirements.txt (torch, stable-baselines3, gymnasium) + race_env_v7.py (física, sin cambios) y training_v8.py en el commit indicado",
            "early_stopping": result["early_stopping"], "training_episodes": result["episodes"], "imitation": {k: v for k, v in result["imitation"].items() if k != "curve"},
            "budget": {"timesteps": result["timesteps"], "ppo_timesteps": result["ppo_timesteps"], "imitation_steps": result["imitation"]["env_steps"],
                       "episodes": result["episodes"]["total"]["episodes"], "train_seconds": round(result["train_seconds"], 1)}})
    finally:
        T7.SOURCE_FILES = old
    s = evaluations["normal"]["summary"]
    folder = result["folder"]
    ep = result["episodes"]["total"]
    (folder / "README.md").write_text(
        "---\ntags:\n- reinforcement-learning\n- ppo\n- imitation-learning\n- gymnasium\n---\n\n"
        f"# Autonomous Rally N8 · PPO (Stable-Baselines3, red {'×'.join(str(n) for n in config['training']['ppo']['net_arch'])})\n\n"
        f"Semilla {result['seed']}. Primero imita a las reglas (DAgger) y después practica con PPO, con parada temprana.\n\n"
        f"- Entrenamiento: {ep['episodes']} episodios, {ep['steps']} pasos (imitación + práctica).\n"
        f"- Examen en la suite `{EVALUATION_SUITE_ID}` (30 pistas nunca vistas): vueltas completas {s['success_rate']:.0%}, "
        f"vueltas limpias {s['clean_rate']:.0%}"
        + (f", vuelta media {s['mean_time_s_success']:.1f} s" if s["mean_time_s_success"] else "") + ".\n\n"
        "Cargar: `PPO.load('model.zip')` y normalizar la observación con `normalization.json`; o en el navegador `policy.onnx` "
        "(ya incluye la normalización: entra la observación cruda de 250 números, sale [acelerador, giro]).\n\n"
        "Contrato completo de entrada y salida, libro de episodios y parada temprana en `manifest.json`.\n", encoding="utf-8")
    manifest["files_sha256"]["README.md"] = T7.digest(folder / "README.md")
    write_json(folder / "manifest.json", manifest)
    return manifest
