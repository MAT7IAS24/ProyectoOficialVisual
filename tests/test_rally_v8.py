"""Pruebas del N8: lo que cambia es CÓMO se entrena (parada temprana, corte de episodios, libro de episodios,
nota por vueltas limpias). La física es la del N7 y ya tiene sus pruebas en test_rally_v7.py."""
import json
import unittest
from pathlib import Path

import numpy as np

import training_v8 as T
from race_env_v7 import generate_layout
from race_env_v8 import RallyV8Env, load_config

ROOT = Path(__file__).resolve().parents[1]


class ConfigV8(unittest.TestCase):
    def setUp(self):
        self.config = load_config()

    def test_same_physics_and_sensors_as_n7(self):
        n7 = json.loads((ROOT / "configs" / "rally-v7.json").read_text(encoding="utf-8"))
        for key in ("track", "physics", "terrains", "generator", "sensors", "episode"):
            self.assertEqual(self.config[key], n7[key], key)
        self.assertEqual(RallyV8Env(self.config).observation_space.shape, (250,))

    def test_reward_v8_only_changes_three_numbers(self):
        n7 = json.loads((ROOT / "configs" / "rally-v7.json").read_text(encoding="utf-8"))["reward"]
        changed = {k for k, v in self.config["reward"].items() if n7.get(k) != v}
        self.assertEqual(changed, {"step", "accident", "remaining_fuel_per_l"})
        self.assertEqual(self.config["reward_version"], "v8")

    def test_early_stopping_and_cut_are_configured(self):
        ppo, im = self.config["training"]["ppo"], self.config["training"]["imitation"]
        self.assertGreater(ppo["total_timesteps"], 400_000)                       # más que el N7
        self.assertLess(ppo["min_timesteps"], ppo["total_timesteps"])
        self.assertGreaterEqual(ppo["patience_evals"], 3)
        self.assertLess(ppo["episode_cut_steps"], self.config["episode"]["max_steps"])
        self.assertLessEqual(im["min_rounds"], im["max_rounds"])
        self.assertEqual(set(ppo["env_mix"]), {"normal", "lluvia", "sensor_ruidoso"})

    def test_training_never_uses_exam_or_validation_tracks(self):
        t = self.config["training"]
        exam = set(range(t["evaluation_layout_seed_offset"], t["evaluation_layout_seed_offset"] + t["evaluation_episodes"]))
        valid = set(range(t["validation_layout_seed_offset"], t["validation_layout_seed_offset"] + t["validation_episodes"]))
        for seed in t["seeds"]:
            start = t["imitation"]["layout_seed_offset"] + seed * 10000
            used = set(range(start, start + t["imitation"]["max_rounds"] * t["imitation"]["episodes_per_round"]))
            self.assertFalse(used & exam)
            self.assertFalse(used & valid)
        self.assertFalse(exam & valid)

    def test_hypothesis_was_written_before_training(self):
        e = self.config["experiment"]
        self.assertNotIn("PENDIENTE", e["hypothesis"])
        self.assertEqual(set(e["selection_criteria"]), {"min_clean_rate_ppo", "max_lap_time_s_ppo", "min_success_rate_rain_ppo"})


class ScoreAndStopping(unittest.TestCase):
    @staticmethod
    def summary(clean, success, time_s, progress=100.0):
        return {"clean_rate": clean, "success_rate": success, "mean_time_s_success": time_s, "mean_progress_pct": progress}

    def test_clean_laps_come_first_then_complete_then_time(self):
        s = self.summary
        self.assertGreater(T.score_v8(s(0.6, 0.6, 80)), T.score_v8(s(0.5, 0.9, 60)))
        self.assertGreater(T.score_v8(s(0.5, 0.9, 80)), T.score_v8(s(0.5, 0.8, 60)))
        self.assertGreater(T.score_v8(s(0.5, 0.8, 60)), T.score_v8(s(0.5, 0.8, 70)))
        self.assertGreater(T.score_v8(s(0.1, 0.1, 99)), T.score_v8(s(0.0, 0.0, None)))

    def test_small_time_gain_is_not_an_improvement(self):
        s = self.summary
        old = T.score_v8(s(0.5, 0.8, 70.0))
        self.assertTrue(T.improved(old, None))
        self.assertFalse(T.improved(T.score_v8(s(0.5, 0.8, 69.9)), old))      # 0,1 s: ruido
        self.assertTrue(T.improved(T.score_v8(s(0.5, 0.8, 69.5)), old))
        self.assertTrue(T.improved(T.score_v8(s(0.55, 0.8, 75.0)), old))      # más limpias gana aunque sea más lento
        self.assertFalse(T.improved(T.score_v8(s(0.45, 0.9, 60.0)), old))

    def test_clean_stats(self):
        ev = {"summary": {}, "cases": [{"success": True, "accidents": 0, "time_s": 70.0}, {"success": True, "accidents": 2, "time_s": 90.0},
                                       {"success": False, "accidents": 5, "time_s": 30.0}, {"success": True, "accidents": 0, "time_s": 68.0}]}
        s = T.add_clean_stats(ev)["summary"]
        self.assertEqual(s["clean_rate"], 0.5)
        self.assertEqual(s["mean_time_s_clean"], 69.0)
        self.assertEqual(s["best_time_s"], 68.0)


class LedgerAndCut(unittest.TestCase):
    def test_ledger_counts_every_episode_by_phase_and_cause(self):
        led = T.Ledger()
        led.add("imitacion", 280, "vuelta_completada")
        led.add("imitacion", 40, "demasiados_accidentes")
        led.add("practica_ppo", 400, "corte_de_entrenamiento")
        d = led.as_dict()
        self.assertEqual(d["imitacion"]["episodes"], 2)
        self.assertEqual(d["imitacion"]["mean_steps_per_episode"], 160.0)
        self.assertEqual(d["total"], {"episodes": 3, "steps": 720, "by_cause": {"vuelta_completada": 1, "demasiados_accidentes": 1, "atascado": 0,
                                                                                 "limite_pasos": 0, "corte_de_entrenamiento": 1}})

    def test_training_cut_truncates_but_exam_env_does_not(self):
        config = load_config()
        layout = generate_layout(config, 123)
        env = T.TrainingCut(RallyV8Env(config), cut_steps=5)
        env.reset(seed=123, options={"layout": layout})
        for i in range(5):
            _, _, terminated, truncated, info = env.step(np.zeros(2, np.float32))    # sin pedal: no avanza, no choca
            if terminated or truncated:
                break
        self.assertTrue(truncated)
        self.assertEqual(info["steps"], 5)
        self.assertEqual(info["termination_cause"], "corte_de_entrenamiento")
        plain = RallyV8Env(config)
        plain.reset(seed=123, options={"layout": layout})
        for _ in range(5):
            _, _, terminated, truncated, _ = plain.step(np.zeros(2, np.float32))
        self.assertFalse(terminated or truncated)


class Catalog(unittest.TestCase):
    def test_catalog_lists_every_experiment_and_totals_add_up(self):
        path = ROOT / "rally-dashboard" / "dist" / "catalogo.json"
        if not path.exists():
            self.skipTest("catalogo.json se genera con build_catalog.py")
        cat = json.loads(path.read_text(encoding="utf-8"))
        rows = cat["experiments"]
        self.assertEqual([r["id"] for r in rows], [f"N{i}" for i in range(1, 9)])
        self.assertEqual(cat["totals"]["models"], sum(r["models"] for r in rows))
        self.assertEqual(cat["totals"]["episodes"], sum(r["episodes"] for r in rows))
        self.assertEqual(cat["totals"]["steps"], sum(r["steps"] for r in rows))


if __name__ == "__main__":
    unittest.main()
