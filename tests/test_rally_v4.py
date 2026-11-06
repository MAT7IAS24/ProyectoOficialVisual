"""Pruebas de física y contrato del N4. Ejecutar: python -m unittest tests.test_rally_v4"""
import hashlib
import math
import unittest

import numpy as np
from gymnasium.utils.env_checker import check_env

from race_env_v4 import DiscreteRallyV4, RallyV4Env, Track, generate_layout, load_config
from training_v4 import ROOT, evaluate, evaluation_layouts, rule_policy

G = 9.81


def flat_layout(config, ground=None, deck=None):
    """Pista vacía de 4 carriles; se pueden escribir celdas con {(carril, celda): código}."""
    base = generate_layout(config, 1)
    n = base["cells"]
    rows = [["."] * n for _ in range(4)]
    decks = [["-"] * n for _ in range(4)]
    for (lane, cell), code in (ground or {}).items():
        rows[lane][cell] = code
    for (lane, cell), code in (deck or {}).items():
        decks[lane][cell] = code
    return {**base, "seed": -1, "ground": ["".join(r) for r in rows], "deck": ["".join(r) for r in decks]}


def placed(layout, lane=1, s=5.0, v=0.0, **kw):
    env = RallyV4Env(**kw)
    env.reset(seed=0, options={"layout": layout})
    env.s, env.max_s, env.d, env.v, env.psi = s, s, env.lane_center(lane), v, 0.0
    return env


class ContractTests(unittest.TestCase):
    def test_gymnasium_contract(self):
        env = RallyV4Env()
        check_env(env, skip_render_check=True)
        self.assertEqual(env.observation_space.shape, (134,))
        self.assertEqual(env.action_space.shape, (2,))
        with self.assertRaises(ValueError):
            env.step(np.array([np.nan, 0]))

    def test_layouts_are_reproducible_and_random(self):
        c = load_config()
        self.assertEqual(generate_layout(c, 5), generate_layout(c, 5))
        self.assertNotEqual(generate_layout(c, 5)["ground"], generate_layout(c, 6)["ground"])

    def test_every_section_has_a_lane_without_barrier_or_pit(self):
        c = load_config()
        for seed in range(40):
            lay = generate_layout(c, seed)
            for start in range(4, lay["cells"] - 3, 10):
                free = [all(lay["ground"][l][k] not in "BFR" for k in range(start, min(start + 10, lay["cells"] - 3))) for l in range(4)]
                bridge = any(lay["deck"][l][k] != "-" for l in range(4) for k in range(start, min(start + 10, lay["cells"])))
                self.assertTrue(any(free) or bridge, f"semilla {seed}, sección {start}")

    def test_track_geometry_closes(self):
        t = Track(300, 80)
        self.assertAlmostEqual(t.length, 600 + 160 * math.pi)
        a, b = t.center(0), t.center(t.length - 1e-9)
        self.assertAlmostEqual(a[0], b[0], places=4)
        self.assertAlmostEqual(a[1], b[1], places=4)


class PhysicsTests(unittest.TestCase):
    def setUp(self):
        self.c = load_config()

    def coast(self, code, v=20.0, steps=4):
        lay = flat_layout(self.c, {(1, k): code for k in range(0, 30)})
        env = placed(lay, v=v, s=20)
        v0 = env.v
        for _ in range(steps):
            env.step(np.array([0.0, 0.0]))
        return v0, env.v, steps * env.p["dt_s"]

    def test_mud_brakes_with_rolling_resistance(self):
        v0, v1, t = self.coast("L")
        expected = 0.30 * G + 0.0008 * 20 ** 2           # resistencia del lodo + aire (aprox.)
        self.assertAlmostEqual((v0 - v1) / t, expected, delta=0.35)
        vd0, vd1, _ = self.coast(".")
        self.assertGreater(v0 - v1, 5 * (vd0 - vd1))     # el lodo frena mucho más que la tierra

    def test_acceleration_is_limited_by_grip(self):
        lay = flat_layout(self.c, {(1, k): "A" for k in range(0, 30)})
        env = placed(lay, v=0, s=20)
        env.step(np.array([1.0, 0.0]))
        self.assertLessEqual(env.v / env.p["dt_s"], 0.30 * G + 0.01)   # en agua solo 2,9 m/s² de tracción

    def test_ramp_jump_follows_gravity(self):
        lay = flat_layout(self.c, {(1, 10): "R"})
        env = placed(lay, v=20.0, s=90)
        took, landed, info = None, None, None
        for _ in range(40):
            _, _, _, _, info = env.step(np.array([0.0, 0.0]))
            if took is None and info["jumps"]:
                took = info["jumps"][0]["s"]
            if took is not None and "aterriza" in info["events"]:
                landed = info["s"]
                break
        self.assertIsNotNone(took)
        ang = math.radians(20)
        v = 20.0 - 0.6                                     # pierde algo de velocidad por aire y tierra antes de la rampa
        vx, vz = v * math.cos(ang), v * math.sin(ang)
        t = (vz + math.sqrt(vz ** 2 + 2 * G * 1.2)) / G
        self.assertAlmostEqual(landed - took, vx * t, delta=2.5)

    def test_slow_car_falls_in_pit_after_ramp(self):
        lay = flat_layout(self.c, {(1, 10): "R", (1, 11): "F", (1, 12): "F"})
        env = placed(lay, v=8.0, s=95)
        events = []
        for _ in range(20):
            _, _, _, _, info = env.step(np.array([0.0, 0.0]))
            events += info["events"]
        self.assertIn("cae_en_foso", events)

    def test_barrier_stops_the_car(self):
        lay = flat_layout(self.c, {(1, 10): "B"})
        env = placed(lay, v=15.0, s=90)
        _, reward, _, _, info = env.step(np.array([0.0, 0.0]))
        for _ in range(3):
            if "choca_con_la_valla" in info["events"]:
                break
            _, reward, _, _, info = env.step(np.array([0.0, 0.0]))
        self.assertIn("choca_con_la_valla", info["events"])
        self.assertEqual(info["speed_mps"], 0.0)
        self.assertEqual(info["accidents"], 1)

    def test_slow_contact_with_barrier_is_not_an_accident(self):
        lay = flat_layout(self.c, {(1, 10): "B"})
        env = placed(lay, v=3.0, s=101)
        for _ in range(6):
            _, _, _, _, info = env.step(np.array([0.2, 0.0]))
        self.assertEqual(info["accidents"], 0)
        self.assertLess(info["s"], 105)

    def test_pit_respawn_leaves_room_to_jump(self):
        lay = flat_layout(self.c, {(1, 10): "R", (1, 11): "F", (1, 12): "F"})
        env = placed(lay, v=8.0, s=95)
        for _ in range(20):
            _, _, _, _, info = env.step(np.array([0.0, 0.0]))
            if "cae_en_foso" in info["events"]:
                break
        self.assertLessEqual(info["s"], 100 - 44)              # 45 m antes del inicio de la rampa
        self.assertGreater(math.sqrt(2 * 6.0 * (100 - info["s"])), 17)   # puede tomar impulso suficiente

    def test_bridge_gap_needs_speed(self):
        deck = {(1, k): "P" for k in range(10, 16)}
        deck[(1, 13)] = "G"
        deck[(1, 15)] = "D"                                # bajada al final, como en el generador
        lay = flat_layout(self.c, deck=deck)
        results = {}
        for v in (12.0, 24.0):
            env = placed(lay, v=v, s=126)
            env.on_deck, env.z = True, 3.0
            events = []
            for _ in range(10):
                _, _, _, _, info = env.step(np.array([0.0, 0.0]))
                events += info["events"]
            results[v] = events
        # 6 m de hueco: a 12 m/s tarda 0,5 s y cae 0,5·9,81·0,5² = 1,2 m (más que el margen de 0,6 m).
        self.assertTrue({"cae_del_puente", "choca_con_el_borde_del_puente"} & set(results[12.0]))
        self.assertIn("vuela_sobre_el_hueco", results[24.0])
        self.assertIn("aterriza_en_el_puente", results[24.0])
        self.assertFalse({"cae_del_puente", "choca_con_el_borde_del_puente"} & set(results[24.0]))

    def test_leaving_track_is_an_accident(self):
        env = placed(flat_layout(self.c), v=15.0, s=20, lane=0)
        for _ in range(10):
            _, _, _, _, info = env.step(np.array([0.5, 1.0]))
            if info["accidents"]:
                break
        self.assertIn("sale_de_la_pista", info["events"])

    def test_standing_still_ends_as_stalled(self):
        env = placed(flat_layout(self.c), v=0.0)
        for _ in range(60):
            _, reward, terminated, truncated, info = env.step(np.array([-1.0, 0.0]))
            if terminated:
                break
        self.assertEqual(info["termination_cause"], "atascado")
        self.assertLess(reward, -5)

    def test_rain_reduces_grip(self):
        dry, wet = RallyV4Env(), RallyV4Env(perturbation="lluvia")
        dry.reset(seed=0, options={"layout": flat_layout(self.c)})
        wet.reset(seed=0, options={"layout": flat_layout(self.c)})
        self.assertAlmostEqual(wet.terrain(10, 1)[1], dry.terrain(10, 1)[1] * 0.7)


class AgentTests(unittest.TestCase):
    def test_discrete_wrapper_for_qlearning(self):
        env = DiscreteRallyV4(RallyV4Env())
        state, _ = env.reset(seed=1)
        self.assertEqual(env.observation_space.n, 720)
        self.assertEqual(env.action_space.n, 15)
        self.assertTrue(0 <= state < 720)

    def test_rule_baseline_on_fixed_suite(self):
        c = load_config()
        lay = evaluation_layouts(c, 4)
        a = evaluate(rule_policy, c, lay)["summary"]
        self.assertEqual(a, evaluate(rule_policy, c, lay)["summary"])
        self.assertGreater(a["success_rate"], 0.4)

    def test_previous_levels_are_untouched(self):
        expected = {
            "race_env.py": "576b958f36f195634edbe94e0c80778984158e96b06af3e8937d9d6fb7aef6f9",
            "race_env_v2.py": "a771f3f78b99554e323ecc66ff2cf8a7591af8b9f14011b8f2cc2f252d4a645f",
            "race_env_v3.py": "2582a7ff707bc4231c288d10bd81fd8efe99720471fedd64ba4fb860470abb34",
            "training_v3.py": "a928ddbe4af1aad49299c117436da7a7b77b5e1158f02193eeb787ed9a11172f",
            "pipeline_v3.py": "36c8571624ae56dbc377567abeddedbd5a530025f2a3257c2c257f5137a10fad",
            "configs/rally-v3.json": "6f4543fb3ce9fdc6d078bcd7b26ddcbbaac2bb2757df6f9876ba47ee8e110c92",
        }
        for path, sha in expected.items():
            self.assertEqual(hashlib.sha256((ROOT / path).read_bytes()).hexdigest(), sha, path)


if __name__ == "__main__":
    unittest.main()
