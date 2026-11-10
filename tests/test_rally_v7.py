"""Pruebas de física y contrato del N7. Ejecutar: python -m unittest tests.test_rally_v7"""
import hashlib
import math
import unittest

import numpy as np
from gymnasium.utils.env_checker import check_env

from race_env_v7 import DiscreteRallyV7, RallyV7Env, Track, generate_layout, load_config, magic_formula
from race_env_v4 import generate_layout as generate_layout_v4, load_config as load_config_v4
from training_v7 import ROOT, bench_tests, evaluate, evaluation_layouts, rule_policy, score_of, validation_layouts

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
    env = RallyV7Env(**kw)
    env.reset(seed=0, options={"layout": layout})
    env.s, env.max_s, env.d, env.psi = s, s, env.lane_center(lane), psi
    env.vx, env.vy, env.r = v, 0.0, 0.0
    return env


class WeightTransferTests(unittest.TestCase):
    """Lo nuevo del N6: el peso se mueve y la suspensión lo hace con retraso."""

    def test_static_weight_matches_center_of_gravity(self):
        env = placed(flat_layout(load_config()))
        loads, Fz = env._wheel_loads()
        self.assertAlmostEqual(Fz, env.p["mass_kg"] * G, delta=1)
        front = (loads[0] + loads[1]) / Fz
        self.assertAlmostEqual(front, env.p["cg_to_rear_m"] / env.p["wheelbase_m"], places=3)
        self.assertAlmostEqual(loads[0], loads[1], places=6)

    def test_braking_moves_weight_forward_with_delay(self):
        env = placed(flat_layout(load_config()), v=25.0)
        dt = env.p["dt_s"] / env.p["substeps"]
        env._substep(-1.0, 0.0, dt, [])
        first = env.pitch
        for _ in range(20):
            env._substep(-1.0, 0.0, dt, [])
        self.assertGreater(env.pitch, first * 3)                 # la trompa se hunde de a poco (suspensión)
        loads, Fz = env._wheel_loads()
        self.assertGreater((loads[0] + loads[1]) / Fz, 0.6)       # más del 60 % adelante (en reposo 54 %)

    def test_accelerating_moves_weight_back(self):
        env = placed(flat_layout(load_config()), v=5.0)
        dt = env.p["dt_s"] / env.p["substeps"]
        for _ in range(30):
            env._substep(1.0, 0.0, dt, [])
        self.assertLess(env.pitch, 0)                             # trompa arriba
        loads, Fz = env._wheel_loads()
        self.assertGreater((loads[2] + loads[3]) / Fz, 0.47)

    def test_left_turn_loads_the_right_wheels_and_leans_right(self):
        env = placed(flat_layout(load_config()), lane=3, v=15.0)
        for _ in range(4):
            _, _, _, _, info = env.step([0.2, 0.35])
        self.assertGreater(info["roll_deg"], 1.0)
        self.assertGreater(info["wheel_loads"][1] + info["wheel_loads"][3], 0.6)

    def test_load_sensitivity_reduces_axle_grip_when_weight_shifts(self):
        env = placed(flat_layout(load_config()))
        w = env.p["mass_kg"] * G / 4
        even = env._axle_capacity(1.0, w, w)
        shifted = env._axle_capacity(1.0, 0.4 * w, 1.6 * w)
        self.assertLess(shifted, even)
        self.assertGreater(shifted, 0.9 * even)

    def test_brake_split_follows_load(self):
        c = load_config()
        env = placed(flat_layout(c), v=25.0)
        env.pitch = 0.03                                         # trompa hundida: peso adelante
        env.pedal = -1.0
        env._tire_dynamics(1.0, 0.0, 0.0, 0.0025, [])
        self.assertFalse(env.wheelspin)                          # el eje trasero liviano no se bloquea

    def test_landing_compresses_and_rebounds(self):
        env = placed(flat_layout(load_config()), v=15.0)
        env.airborne, env.z, env.vz = True, 0.05, -6.0
        env._takeoff_z, env._from_deck = 1.0, False
        dt, events, heaves = env.p["dt_s"] / env.p["substeps"], [], []
        for _ in range(60):
            env._substep(0.0, 0.0, dt, events)
            heaves.append(env.heave)
        self.assertIn("aterriza", events)
        self.assertGreater(max(heaves), 0.15)                    # los resortes se comprimen
        self.assertLess(abs(heaves[-1]), 0.03)                   # y vuelven al reposo
        self.assertEqual(env.accidents, 0)

    def test_big_drop_hits_the_bump_stops(self):
        env = placed(flat_layout(load_config()), v=15.0)
        env.airborne, env.z, env.vz = True, 0.05, -10.0
        env._takeoff_z, env._from_deck = 3.0, False
        _, _, _, _, info = env.step([0.0, 0.0])
        self.assertIn("aterriza", info["events"])
        self.assertIn("golpea_los_topes", info["events"])        # 10 m/s: se acaba el recorrido...
        self.assertEqual(info["accidents"], 0)                    # ...pero no se rompe (eso es > 12 m/s)

    def test_bench_tests_look_like_a_real_car(self):
        b = bench_tests(load_config())
        self.assertTrue(1.0 <= b["cabeceo_max_deg"] <= 3.0, b)
        self.assertTrue(2.0 <= b["balanceo_deg"] <= 5.0, b)
        self.assertTrue(35 <= b["frenada_100_m"] <= 50, b)

    def test_new_observations(self):
        env = placed(flat_layout(load_config()), v=20.0)
        obs, *_ = env.step([-1.0, 0.0])
        names = list(env.BASE_OBS)
        self.assertGreater(obs[names.index("peso_adelante")], 0.1)
        self.assertGreater(obs[names.index("cabeceo")], 0.1)


class PilotViewTests(unittest.TestCase):
    """Lo nuevo del N7: mirada por tiempo (tipo Sophy) y recompensa v7."""

    def test_course_points_look_further_when_faster(self):
        names = list(RallyV7Env.HEAD_OBS)
        i = names.index("pista_5s_adelante")
        slow = placed(flat_layout(load_config()), v=8.0)
        fast = placed(flat_layout(load_config()), v=28.0)
        o_slow, o_fast = slow._obs(), fast._obs()
        self.assertAlmostEqual(o_slow[i] * 200, 40.0, delta=2.0)     # 8 m/s × 5 s
        self.assertAlmostEqual(o_fast[i] * 200, 140.0, delta=3.0)    # 28 m/s × 5 s
        self.assertGreater(o_fast[i], o_slow[i])

    def test_course_points_show_a_coming_curve(self):
        env = placed(flat_layout(load_config()), v=25.0)
        env.s = env.track.S - 40.0                                  # 40 m antes de la curva
        o = env._obs(); names = list(env.HEAD_OBS)
        self.assertEqual(o[names.index("pista_0.5s_curva")], 0.0)  # aquí todavía es recta
        self.assertAlmostEqual(o[names.index("pista_3s_curva")], 1.0, places=3)   # a 75 m ya es curva (×radio = 1)
        self.assertGreater(o[names.index("pista_5s_costado")], 0.2)              # la pista se va hacia un lado

    # Recompensa v7 del intento 1 (el intento 2 vuelve a v5 poniendo estos dos términos en 0).
    V7 = {"accident": -5.0, "accident_per_v2": 0.01, "slip_per_deg": 0.002, "slip_free_deg": 6.0}

    def test_crash_cost_grows_with_speed(self):
        rw = self.V7
        cost = lambda v: rw["accident"] - rw["accident_per_v2"] * v ** 2
        self.assertAlmostEqual(cost(0), -5.0)
        self.assertLess(cost(25), 2 * cost(0))                      # a 90 km/h cuesta más del doble que casi parado
        self.assertLess(cost(25), cost(8) - 5)                      # y 5 puntos más que a 30 km/h

    def test_crash_reward_uses_speed_at_impact(self):
        env = placed(flat_layout(load_config()), v=20.0)
        env.crash_speeds = []
        env._crash([], "sale_de_la_pista")
        self.assertAlmostEqual(env.crash_speeds[0], 20.0, places=3)

    def test_attempt_2_uses_the_n6_reward(self):
        c = load_config()
        self.assertEqual(c["reward_version"], "v5")
        self.assertEqual(c["reward"]["accident_per_v2"], 0.0)
        self.assertEqual(c["reward"]["slip_per_deg"], 0.0)
        self.assertEqual(c["reward"]["accident"], -5.0)

    def test_slip_penalty_only_above_free_angle(self):
        rw = self.V7
        pen = lambda deg: -rw["slip_per_deg"] * max(0.0, deg - rw["slip_free_deg"])
        self.assertEqual(pen(4.0), 0.0)
        self.assertAlmostEqual(pen(16.0), -0.02)

    def test_reward_components_are_reported(self):
        env = placed(flat_layout(load_config()), v=10.0)
        _, _, _, _, info = env.step([0.3, 0.0])
        self.assertIn("derrape", info["reward_components"])
        self.assertIn("crash_speeds_kmh", info)


class ContractTests(unittest.TestCase):
    def test_gymnasium_contract(self):
        env = RallyV7Env()
        check_env(env, skip_render_check=True)
        self.assertEqual(env.observation_space.shape, (250,))
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
        dry, wet = RallyV7Env(), RallyV7Env(perturbation="lluvia")
        dry.reset(seed=0, options={"layout": flat_layout(self.c)})
        wet.reset(seed=0, options={"layout": flat_layout(self.c)})
        self.assertAlmostEqual(wet.terrain(10, 1)[1], dry.terrain(10, 1)[1] * 0.7)

    def test_poses_carry_steer_and_slip_for_the_web(self):
        env = placed(flat_layout(self.c), v=15.0, s=20)
        _, _, _, _, info = env.step(np.array([0.5, 0.5]))
        self.assertEqual(len(info["poses"]), env.p["substeps"])
        self.assertEqual(len(info["poses"][0]), 9)        # x, y, altura, rumbo, volante, deslizamiento, cabeceo, balanceo, compresión


class AgentTests(unittest.TestCase):
    def test_discrete_wrapper_for_qlearning(self):
        env = DiscreteRallyV7(RallyV7Env())
        state, _ = env.reset(seed=1)
        self.assertEqual(env.observation_space.n, 720)
        self.assertEqual(env.action_space.n, 15)
        self.assertTrue(0 <= state < 720)

    def test_sensor_noise_now_reaches_qlearning(self):
        """Arreglo del N5: con 'sensor_ruidoso' la tabla también lee con ruido."""
        clean = DiscreteRallyV7(RallyV7Env())
        noisy = DiscreteRallyV7(RallyV7Env(perturbation="sensor_ruidoso"))
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

    def test_validation_tracks_are_not_the_exam(self):
        # Intento 2: el mejor punto del entrenamiento se elige en pistas de validación, distintas del examen.
        c = load_config()
        valid = validation_layouts(c)
        self.assertGreaterEqual(len(valid), 5)
        exam = {l["seed"] for l in evaluation_layouts(c)}
        self.assertFalse(exam & {l["seed"] for l in valid})
        self.assertEqual(len({l["seed"] for l in valid}), len(valid))
        better = {"success_rate": 0.2, "mean_progress_pct": 40.0, "mean_return": 1.0}
        worse = {"success_rate": 0.1, "mean_progress_pct": 90.0, "mean_return": 9.0}
        self.assertGreater(score_of(better), score_of(worse))   # primero cuentan las vueltas completas

    def test_previous_levels_are_untouched(self):
        expected = {
            "race_env_v4.py": "dda8c908029f24fbb1be99737084bffed0dc5a3bcfed14cafff9e2ceb7f4486b",
            "training_v4.py": "d88a9b1242fd6818e810e1eb44fa8c7d16dd43eb4254d673f04965ae9fe0349d",
            "configs/rally-v4.json": "66ab156a36206bd91adae25296e9dc1eee445da184fbe329c733adb4b56428cb",
            "race_env_v5.py": "96b55c4a8fc4bf7a1b7e81a4445e6ff4a9ac66893eb6fc4cd6b84c98bb96febe",
            "training_v5.py": "7448f67fd604427397be30a7db282f3298b593f856762d2ccaf9bdf36c943c8e",
            "configs/rally-v5.json": "e0059d8a6587e4c35962ab519da882c81e0804b3adbb598bd34d6dc5bc661b21",
            "pipeline_v5.py": "dbc396804e1eb2e25980cc9615dd66935814db7045c946098023ff6c5872c989",
            "race_env_v6.py": "f22985238c902b07845911035c578e832cd87401b85b0a3b5da96f2e09de9a7a",
            "training_v6.py": "f1ffad5f4a37d978020e0b9f7644e5b43d0bf9033cd5944fa53225c961b39828",
            "configs/rally-v6.json": "42f00faac0324338b92107ee2af86a748a8ccc5138b67dbeadef185f1f585fc2",
            "pipeline_v6.py": "9a936e48f3645fa288c01daf0e288ed3f72e3a7ef67bed3b37493382dd399a64",
        }
        for path, sha in expected.items():
            data = (ROOT / path).read_bytes().replace(b"\r\n", b"\n")   # igual en Windows (CRLF) y Linux
            self.assertEqual(hashlib.sha256(data).hexdigest(), sha, path)


if __name__ == "__main__":
    unittest.main()
