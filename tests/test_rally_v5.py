"""Pruebas de física y contrato del N5. Ejecutar: python -m unittest tests.test_rally_v5"""
import hashlib
import math
import unittest

import numpy as np
from gymnasium.utils.env_checker import check_env

from race_env_v5 import DiscreteRallyV5, RallyV5Env, Track, generate_layout, load_config, magic_formula
from race_env_v4 import generate_layout as generate_layout_v4, load_config as load_config_v4
from training_v5 import ROOT, evaluate, evaluation_layouts, rule_policy

G = 9.81


def flat_layout(config, ground=None, deck=None):
    """Pista de asfalto de 4 carriles; se pueden escribir celdas con {(carril, celda): código}."""
    base = generate_layout(config, 1)
    n = base["cells"]
    rows = [["."] * n for _ in range(4)]
    decks = [["-"] * n for _ in range(4)]
    for (lane, cell), code in (ground or {}).items():
        rows[lane][cell] = code
    for (lane, cell), code in (deck or {}).items():
        decks[lane][cell] = code
    return {**base, "seed": -1, "ground": ["".join(r) for r in rows], "deck": ["".join(r) for r in decks]}


def everywhere(config, code, cells=range(0, 60)):
    return flat_layout(config, {(l, k): code for l in range(4) for k in cells})


def placed(layout, lane=1, s=5.0, v=0.0, psi=0.0, **kw):
    env = RallyV5Env(**kw)
    env.reset(seed=0, options={"layout": layout})
    env.s, env.max_s, env.d, env.psi = s, s, env.lane_center(lane), psi
    env.vx, env.vy, env.r = v, 0.0, 0.0
    return env


class ContractTests(unittest.TestCase):
    def test_gymnasium_contract(self):
        env = RallyV5Env()
        check_env(env, skip_render_check=True)
        self.assertEqual(env.observation_space.shape, (140,))
        self.assertEqual(env.action_space.shape, (2,))
        with self.assertRaises(ValueError):
            env.step(np.array([np.nan, 0]))

    def test_same_tracks_as_n4(self):
        """La suite de evaluación usa las mismas pistas que el N4: la comparación es justa."""
        c5, c4 = load_config(), load_config_v4()
        for seed in (100000, 100007, 100029):
            a, b = generate_layout(c5, seed), generate_layout_v4(c4, seed)
            self.assertEqual(a["ground"], b["ground"])
            self.assertEqual(a["deck"], b["deck"])

    def test_config_validation(self):
        c = load_config()
        c["physics"]["cg_to_front_m"] = 2.0
        with self.assertRaises(ValueError):
            load_config(c)

    def test_track_geometry_closes(self):
        t = Track(300, 80)
        a, b = t.center(0), t.center(t.length - 1e-9)
        self.assertAlmostEqual(a[0], b[0], places=4)
        self.assertAlmostEqual(a[1], b[1], places=4)


class TireTests(unittest.TestCase):
    def test_magic_formula_shape(self):
        """La fuerza crece con el deslizamiento, llega a un máximo cercano a 1 y luego se satura."""
        B, C, E = 9.0, 1.8, 0.95
        values = [magic_formula(math.radians(a), B, C, E) for a in range(0, 31)]
        self.assertEqual(values[0], 0.0)
        self.assertGreater(values[3], values[1])
        self.assertAlmostEqual(max(values), 1.0, delta=0.02)
        self.assertGreater(values[-1], 0.6)                 # se satura, no se desploma
        self.assertAlmostEqual(magic_formula(-0.1, B, C, E), -magic_formula(0.1, B, C, E))


class PhysicsTests(unittest.TestCase):
    def setUp(self):
        self.c = load_config()

    def test_mud_brakes_with_rolling_resistance(self):
        env = placed(everywhere(self.c, "L"), v=20.0, s=20)
        env.pedal = 0.0
        for _ in range(4):
            env.step(np.array([0.0, 0.0]))
        expected = 0.22 * G + 0.0008 * 20 ** 2               # resistencia del lodo + aire
        self.assertAlmostEqual((20.0 - env.v) / 1.0, expected, delta=0.35)

    def test_mud_does_not_push_sideways(self):
        """La queja del N4: en el barro el coche se iba de lado. Empujado de lado a 4 m/s, en el
        barro se corrige más rápido que en el agua y termina avanzando derecho."""
        drift = {}
        for code in ("L", "A"):
            env = placed(everywhere(self.c, code), v=18.0, s=20)
            env.vy = 4.0
            start_d = env.d
            for _ in range(6):
                _, _, _, _, info = env.step(np.array([0.0, 0.0]))
            drift[code] = abs(env.d - start_d)
            if code == "L":
                self.assertLess(abs(info["slip_deg"]), 0.5)
                self.assertLess(abs(info["psi"]), 0.02)
        self.assertLess(drift["L"], drift["A"] * 0.5)

    def test_mud_ruts_resist_crossing(self):
        """Con el mismo volante, cruzar de carril en el barro mueve mucho menos al coche que en asfalto."""
        moved = {}
        for code in (".", "L"):
            env = placed(everywhere(self.c, code), v=12.0, s=20)
            for _ in range(4):
                env.step(np.array([0.3, 0.3]))
            moved[code] = abs(env.d - env.lane_center(1))
        self.assertLess(moved["L"], moved["."] * 0.6)

    def test_friction_circle_traction_limited_by_grip(self):
        env = placed(everywhere(self.c, "A"), v=0.0, s=20)
        env.pedal = 1.0
        env.step(np.array([1.0, 0.0]))
        self.assertLessEqual(env.v / env.p["dt_s"], 0.35 * G + 0.05)   # en agua solo ~3,4 m/s² de tracción
        self.assertTrue(env.wheelspin)

    def test_steering_and_pedal_are_gradual(self):
        env = placed(flat_layout(self.c), v=10.0, s=20)
        _, _, _, _, info = env.step(np.array([0.0, 1.0]))
        # en 0,25 s el volante gira como máximo 1,2 × 0,25 = 0,3 rad (17,2°), no los 0,4 rad pedidos
        self.assertAlmostEqual(info["steer_deg"], math.degrees(0.3), delta=0.2)
        env2 = placed(flat_layout(self.c), v=10.0, s=20)
        env2.step(np.array([1.0, 0.0]))
        self.assertLessEqual(env2.pedal, 1.0)
        self.assertGreater(env2.pedal, 0.99)                # 5 por segundo: a fondo en 0,2 s

    def test_steering_returns_to_center(self):
        env = placed(flat_layout(self.c), v=12.0, s=20)
        for _ in range(2):
            env.step(np.array([0.2, 0.5]))
        self.assertGreater(env.delta, 0.1)
        for _ in range(2):
            env.step(np.array([0.2, 0.0]))
        self.assertEqual(env.delta, 0.0)

    def test_water_allows_a_slide(self):
        """En agua sí se puede derrapar: girar fuerte produce deslizamiento claro."""
        env = placed(everywhere(self.c, "A"), lane=2, v=20.0, s=20)
        worst = 0.0
        for _ in range(6):
            _, _, _, _, info = env.step(np.array([0.5, 0.6]))
            worst = max(worst, abs(info["slip_deg"]))
        self.assertGreater(worst, 6.0)

    def test_spin_is_an_accident(self):
        env = placed(everywhere(self.c, "A"), lane=1, v=5.0, s=20)
        env.vy, env.r = 20.0, 1.5                          # coche ya cruzado (76°) y rotando
        _, _, _, _, info = env.step(np.array([1.0, -1.0]))
        self.assertIn("hace_un_trompo", info["events"])
        self.assertEqual(info["accidents"], 1)

    def test_ramp_jump_follows_gravity(self):
        lay = flat_layout(self.c, {(1, 10): "R"})
        env = placed(lay, v=20.0, s=90)
        took, landed = None, []
        original_land = env._land
        def land(height, events, on_deck):                 # anota dónde toca el suelo (dentro del subpaso)
            landed.append(env.s)
            original_land(height, events, on_deck)
        env._land = land
        for _ in range(40):
            _, _, _, _, info = env.step(np.array([0.0, 0.0]))
            if took is None and info["jumps"]:
                took, v_take = info["jumps"][0]["s"], info["jumps"][0]["v"]
            if landed:
                landed = landed[0]
                break
        self.assertIsNotNone(took)
        ang = math.radians(20)
        vx, vz = v_take * math.cos(ang), v_take * math.sin(ang)
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
        for _ in range(4):
            _, _, _, _, info = env.step(np.array([0.0, 0.0]))
            if "choca_con_la_valla" in info["events"]:
                break
        self.assertIn("choca_con_la_valla", info["events"])
        self.assertEqual(info["speed_mps"], 0.0)
        self.assertEqual(info["accidents"], 1)

    def test_bridge_gap_needs_speed(self):
        deck = {(1, k): "P" for k in range(10, 16)}
        deck[(1, 13)] = "G"
        deck[(1, 15)] = "D"
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
        self.assertTrue({"cae_del_puente", "choca_con_el_borde_del_puente"} & set(results[12.0]))
        self.assertIn("vuela_sobre_el_hueco", results[24.0])
        self.assertIn("aterriza_en_el_puente", results[24.0])

    def test_standing_still_ends_as_stalled(self):
        env = placed(flat_layout(self.c), v=0.0)
        for _ in range(60):
            _, reward, terminated, _, info = env.step(np.array([-1.0, 0.0]))
            if terminated:
                break
        self.assertEqual(info["termination_cause"], "atascado")
        self.assertLess(reward, -5)

    def test_rain_reduces_grip(self):
        dry, wet = RallyV5Env(), RallyV5Env(perturbation="lluvia")
        dry.reset(seed=0, options={"layout": flat_layout(self.c)})
        wet.reset(seed=0, options={"layout": flat_layout(self.c)})
        self.assertAlmostEqual(wet.terrain(10, 1)[1], dry.terrain(10, 1)[1] * 0.7)

    def test_poses_carry_steer_and_slip_for_the_web(self):
        env = placed(flat_layout(self.c), v=15.0, s=20)
        _, _, _, _, info = env.step(np.array([0.5, 0.5]))
        self.assertEqual(len(info["poses"]), env.p["substeps"])
        self.assertEqual(len(info["poses"][0]), 6)        # x, y, altura, rumbo, volante, deslizamiento


class AgentTests(unittest.TestCase):
    def test_discrete_wrapper_for_qlearning(self):
        env = DiscreteRallyV5(RallyV5Env())
        state, _ = env.reset(seed=1)
        self.assertEqual(env.observation_space.n, 720)
        self.assertEqual(env.action_space.n, 15)
        self.assertTrue(0 <= state < 720)

    def test_sensor_noise_now_reaches_qlearning(self):
        """Arreglo del N5: con 'sensor_ruidoso' la tabla también lee con ruido."""
        clean = DiscreteRallyV5(RallyV5Env())
        noisy = DiscreteRallyV5(RallyV5Env(perturbation="sensor_ruidoso"))
        for w in (clean, noisy):
            w.reset(seed=3, options={"layout": flat_layout(load_config())})
            w.env.vx = 11.0
        self.assertEqual(len({clean.encode() for _ in range(30)}), 1)
        self.assertGreater(len({noisy.encode() for _ in range(30)}), 1)

    def test_rule_baseline_on_fixed_suite(self):
        c = load_config()
        lay = evaluation_layouts(c, 6)
        a = evaluate(rule_policy, c, lay)["summary"]
        self.assertEqual(a, evaluate(rule_policy, c, lay)["summary"])
        self.assertGreater(a["success_rate"], 0.5)

    def test_previous_levels_are_untouched(self):
        expected = {
            "race_env_v4.py": "dda8c908029f24fbb1be99737084bffed0dc5a3bcfed14cafff9e2ceb7f4486b",
            "training_v4.py": "d88a9b1242fd6818e810e1eb44fa8c7d16dd43eb4254d673f04965ae9fe0349d",
            "configs/rally-v4.json": "66ab156a36206bd91adae25296e9dc1eee445da184fbe329c733adb4b56428cb",
        }
        for path, sha in expected.items():
            data = (ROOT / path).read_bytes().replace(b"\r\n", b"\n")   # igual en Windows (CRLF) y Linux
            self.assertEqual(hashlib.sha256(data).hexdigest(), sha, path)


if __name__ == "__main__":
    unittest.main()
