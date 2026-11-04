"""Pruebas de reglas del nivel N3 (rally-v3). Ejecutar: python -m unittest tests.test_rally_v3"""
import hashlib
import tempfile
import unittest
from pathlib import Path

import numpy as np
from gymnasium.utils.env_checker import check_env

from environments import make_env
from race_env_v3 import RallyV3Env, apply_perturbation, load_config
from training_v3 import ROOT, evaluate_policy, rule_policy, train_seed

# Carriles (índice 0..3 = carril 1..4 en la web):
# 0 ....LLL.....LL......LLL.......
# 1 ......AA.....AA......AAA....A.
# 2 ...SSS..RFFA.....SSS...RFFA...
# 3 ...B..K...R.LLAA.FLL..K...B.R.   puente: ------------PPPPPGPP----------


def placed(lane, segment, speed, layer=0, fuel=None):
    env = RallyV3Env()
    env.reset(seed=1)
    env.lane, env.segment, env.best_segment, env.speed_level, env.layer = lane, segment, segment, speed, layer
    if fuel is not None:
        env.fuel = fuel
    return env


class ContractTests(unittest.TestCase):
    def test_gymnasium_contract_and_spaces(self):
        env = RallyV3Env()
        check_env(env, skip_render_check=True)
        self.assertEqual(env.state_shape, (31, 4, 4, 4, 2, 11))
        self.assertEqual(env.action_space.n, 5)
        obs, info = env.reset(seed=7)
        self.assertEqual(obs[:3], (0, 0, 3))
        self.assertEqual(obs[4], 0)
        self.assertEqual(info["termination_cause"], "en_curso")
        self.assertIs(make_env("rally-v3").__class__, RallyV3Env)

    def test_start_lane_is_random_but_seeded(self):
        lanes = {RallyV3Env().reset(seed=s)[1]["lane"] for s in range(40)}
        self.assertEqual(lanes, {0, 1, 2, 3})
        self.assertEqual(RallyV3Env().reset(seed=5)[1]["lane"], RallyV3Env().reset(seed=5)[1]["lane"])

    def test_invalid_actions_and_step_after_done(self):
        env = placed(0, 29, 1)
        for bad in (-1, 5, "acelerar"):
            with self.assertRaises(ValueError):
                env.step(bad)
        env.step(1)
        with self.assertRaises(RuntimeError):
            env.step(1)

    def test_config_validation(self):
        config = load_config()
        config["environment"]["lane_layout"][0]["ground"] += "."
        with self.assertRaises(ValueError):
            load_config(config)
        config = load_config()
        config["environment"]["lane_layout"][1]["deck"] = "P" + "-" * 29
        with self.assertRaises(ValueError):
            load_config(config)

    def test_perturbation_is_a_copy(self):
        base = load_config()
        rain = apply_perturbation(base, "lluvia")
        self.assertEqual(rain["environment"]["lane_layout"][3]["ground"][20], "A")
        self.assertEqual(base["environment"]["lane_layout"][3]["ground"][20], ".")
        with self.assertRaises(ValueError):
            apply_perturbation(base, "nieve")


class TerrainTests(unittest.TestCase):
    def test_mud_caps_speed_and_stops_the_step(self):
        obs, reward, *_, info = placed(0, 3, 2).step(1)
        self.assertEqual((info["segment"], info["speed_level"]), (4, 1))
        self.assertIn("frenado_por_lodo", info["events"])
        self.assertAlmostEqual(reward, -1 + 2 - 0.05 * 8)

    def test_water_is_safe_at_two_and_skids_at_three(self):
        *_, info = placed(1, 5, 2).step(1)
        self.assertEqual((info["segment"], info["accidents"]), (7, 0))
        _, reward, *_, info = placed(1, 5, 3).step(1)
        self.assertEqual((info["segment"], info["accidents"], info["speed_level"]), (5, 1, 0))
        self.assertIn("derrape_en_agua", info["events"])
        self.assertEqual(info["crash_segment"], 6)
        self.assertAlmostEqual(reward, -1 - 0.05 * 11 - 8)

    def test_grass_without_track_slows_to_two(self):
        *_, info = placed(2, 2, 3).step(1)
        self.assertEqual((info["segment"], info["speed_level"]), (3, 2))
        self.assertIn("frenado_por_sin_pista", info["events"])

    def test_pit_and_barrel_cause_accidents(self):
        env = placed(2, 7, 1)
        env.step(1)                                   # sube la rampa despacio (no salta)
        self.assertEqual((env.segment, env.speed_level), (8, 1))
        *_, info = env.step(1)                        # cae al foso de 9
        self.assertIn("cae_en_foso", info["events"])
        self.assertEqual((info["segment"], info["accidents"]), (8, 1))
        *_, info = placed(3, 2, 1).step(1)
        self.assertIn("choca_con_barril", info["events"])
        self.assertEqual((info["segment"], info["accidents"]), (2, 1))


class RampAndBridgeTests(unittest.TestCase):
    def test_ramp_jump_skips_cells(self):
        _, reward, *_, info = placed(3, 5, 2).step(1)  # rampa con barril en 6, vuela 2 tramos
        self.assertIn("salta_la_rampa", info["events"])
        self.assertEqual(info["jump"], {"from_segment": 6, "to_segment": 8, "flight": 2, "speed_level": 2})
        self.assertEqual((info["segment"], info["layer"], info["accidents"]), (8, 0, 0))
        self.assertAlmostEqual(reward, -1 + 2 * 3 - 0.05 * 8)

    def test_slow_on_ramp_with_barrel_crashes(self):
        *_, info = placed(3, 5, 1).step(1)
        self.assertIn("choca_con_el_barril_de_la_rampa", info["events"])
        self.assertEqual((info["segment"], info["accidents"]), (5, 1))

    def test_trap_ramp_lands_in_pit_or_water(self):
        *_, info = placed(2, 7, 2).step(1)            # aterriza en el foso de 10
        self.assertIn("cae_en_foso", info["events"])
        *_, info = placed(2, 7, 3).step(1)            # aterriza en el agua de 11 a velocidad 3
        self.assertIn("derrape_en_agua", info["events"])

    def test_jump_lands_on_bridge_and_blocks_lane_change(self):
        env = placed(3, 9, 2)
        *_, info = env.step(1)
        self.assertEqual((info["segment"], info["layer"]), (12, 1))
        self.assertIn("aterriza_en_el_puente", info["events"])
        self.assertEqual(info["terrain_here"], "puente")
        *_, info = env.step(3)
        self.assertEqual(info["lane"], 3)
        self.assertIn("cambio_de_carril_bloqueado_en_puente", info["events"])

    def test_bridge_gap_needs_full_speed(self):
        *_, info = placed(3, 16, 2, layer=1).step(1)
        self.assertIn("cae_del_puente", info["events"])
        self.assertEqual((info["segment"], info["layer"], info["accidents"]), (17, 0, 1))
        *_, info = placed(3, 16, 3, layer=1).step(1)
        self.assertIn("cruza_el_hueco_del_puente", info["events"])
        self.assertEqual((info["segment"], info["layer"], info["accidents"]), (19, 1, 0))

    def test_leaving_the_bridge_goes_down_to_ground(self):
        *_, info = placed(3, 19, 1, layer=1).step(1)
        self.assertEqual((info["segment"], info["layer"]), (20, 0))
        self.assertIn("baja_del_puente", info["events"])


class LaneFuelAndEndTests(unittest.TestCase):
    def test_lane_change_costs_fuel_and_has_limits(self):
        _, reward, *_, info = placed(1, 0, 0).step(4)
        self.assertEqual((info["lane"], info["fuel"]), (2, 147))
        self.assertAlmostEqual(reward, -1 - 0.05 * 3)
        *_, info = placed(0, 0, 0).step(3)
        self.assertEqual(info["lane"], 0)
        self.assertIn("cambio_de_carril_bloqueado_por_muro", info["events"])
        *_, info = placed(1, 0, 3).step(4)
        self.assertEqual((info["lane"], info["accidents"], info["segment"]), (1, 1, 0))
        self.assertIn("derrape_al_cambiar_de_carril", info["events"])

    def test_progress_reward_never_repeats(self):
        env = placed(1, 5, 3)
        env.step(1)                                   # derrapa en 6, vuelve a 5
        env.best_segment = 7
        _, reward, *_, info = env.step(2)             # vuelve a 6: ya cobrado
        self.assertEqual(info["new_segments"], 0)
        self.assertEqual(info["reward_components"]["progress"], 0)

    def test_finish_line_and_bonus(self):
        _, reward, terminated, truncated, info = placed(0, 29, 1, fuel=50).step(1)
        self.assertTrue(terminated)
        self.assertFalse(truncated)
        self.assertEqual(info["termination_cause"], "vuelta_completada")
        self.assertAlmostEqual(reward, -1 + 2 - 0.05 * 5 + 20 + 0.1 * 45)

    def test_too_many_accidents(self):
        env = placed(1, 5, 3)
        env.accidents = 3
        _, _, terminated, _, info = env.step(1)
        self.assertTrue(terminated)
        self.assertEqual(info["termination_cause"], "demasiados_accidentes")

    def test_out_of_fuel_and_time_limit_are_distinct(self):
        env = placed(0, 0, 0, fuel=2)
        _, _, terminated, truncated, info = env.step(0)
        self.assertTrue(terminated and not truncated)
        self.assertEqual(info["termination_cause"], "sin_combustible")
        config = load_config()
        config["environment"]["fuel_base_cost"] = 0
        env = RallyV3Env(config)
        env.reset(seed=1)
        for _ in range(100):
            _, _, terminated, truncated, info = env.step(0)
        self.assertTrue(truncated and not terminated)
        self.assertEqual(info["termination_cause"], "limite_pasos")


class TrainingTests(unittest.TestCase):
    def test_training_reproducible_and_conditions_recorded(self):
        config = load_config()
        config["training"]["episodes"] = 30
        config["training"]["evaluation_episodes"] = 3
        with tempfile.TemporaryDirectory() as root:
            a, b = train_seed(config, 7, root), train_seed(config, 7, root)
            mix = train_seed(config, 7, root, condition="clima_mixto", parent_run_id=a["experiment_id"])
            self.assertEqual(a["metadata"]["model_sha256"], b["metadata"]["model_sha256"])
            self.assertEqual(a["metadata"]["dataset_sha256"], b["metadata"]["dataset_sha256"])
            self.assertNotEqual(a["experiment_id"], b["experiment_id"])
            self.assertNotEqual(a["metadata"]["model_sha256"], mix["metadata"]["model_sha256"])
            self.assertEqual(mix["metadata"]["parent_run_id"], a["experiment_id"])
            self.assertEqual(np.load(Path(a["model_dir"]) / "q_table.npy").shape, (43648, 5))
            for name in ("manifest.json", "metadata.json", "config.json", "evaluation.json", "README.md"):
                self.assertTrue((Path(a["model_dir"]) / name).exists(), name)
        with self.assertRaises(ValueError):
            train_seed(config, 7, condition="nieve")

    def test_rule_baseline_runs_on_fixed_suite(self):
        config = load_config()
        config["training"]["evaluation_episodes"] = 5
        first = evaluate_policy(rule_policy, config, 7)["summary"]
        self.assertEqual(first, evaluate_policy(rule_policy, config, 7)["summary"])

    def test_previous_levels_are_untouched(self):
        expected = {
            "race_env.py": "576b958f36f195634edbe94e0c80778984158e96b06af3e8937d9d6fb7aef6f9",
            "train.py": "5af3533ce908929ab55bf475a8e70659c23c0d9f8e70631a43f2ca87f462f940",
            "pipeline.py": "8d62ea487c226e965c843ae4da77fd229b3590a7ac5b201ae2fa912439d3787b",
            "race_env_v2.py": "a771f3f78b99554e323ecc66ff2cf8a7591af8b9f14011b8f2cc2f252d4a645f",
            "training_v2.py": "e44174f82dfaa676b932589c9c1873ebcbe9383b29a2d0f21c0aa68ac2bc77ed",
            "pipeline_v2.py": "f334678f6d42806e05aba440029f5cc6700d6903fdaacfa12330ae7e5b7deac8",
            "configs/rally-v2.json": "86ce8d6891ec88c2f2059266b8c5e5c48c3c383dce5f70a1ec40bcfa43a044d6",
        }
        for path, sha in expected.items():
            self.assertEqual(hashlib.sha256((ROOT / path).read_bytes()).hexdigest(), sha, path)
        self.assertEqual(make_env("rally-v2").state_shape, (11, 4, 4, 3))


if __name__ == "__main__":
    unittest.main()
