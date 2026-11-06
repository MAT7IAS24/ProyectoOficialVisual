"""Contract and sparse-learning tests for Rally v4 / N4."""
import tempfile
import unittest
from pathlib import Path

import numpy as np
from gymnasium.utils.env_checker import check_env

from environments import make_env
from race_env_v4 import RallyV4Env, load_config
from training_v4 import train_seed, update_q


class EnvironmentTests(unittest.TestCase):
    def test_gymnasium_contract_and_selector(self):
        env = RallyV4Env()
        check_env(env, skip_render_check=True)
        observation, info = env.reset(seed=7)
        self.assertEqual(len(observation), 11)
        self.assertEqual(observation[:6], (0, 0, 3, info["lane"], 0, 0))
        self.assertEqual(observation[6:], (150, 0, 0, 0, 0))
        self.assertEqual(info["environment_version"], "rally-v4")
        self.assertIsInstance(make_env("rally-v4"), RallyV4Env)
        self.assertEqual(env.action_space.n, 5)

    def test_hidden_history_and_weather_are_observable(self):
        env = RallyV4Env()
        env.reset(seed=4)
        initial = env.observation()
        env.fuel -= 1
        self.assertNotEqual(env.observation()[6], initial[6])
        env.accidents = 1
        self.assertEqual(env.observation()[7], 1)
        env.steps = 1
        self.assertEqual(env.observation()[8], 1)
        env.best_segment = 2
        self.assertEqual(env.observation()[9], 2)
        rain = RallyV4Env(perturbation="lluvia")
        rain.reset(seed=4)
        self.assertEqual(rain.observation()[10], 1)
        self.assertNotEqual(env.encode(initial), env.encode(rain.observation()))

    def test_state_encoding_distinguishes_previously_aliased_states(self):
        env = RallyV4Env()
        env.reset(seed=1)
        state = env.observation()
        variants = []
        for field, value in ((6, 149), (7, 1), (8, 1), (9, 1), (10, 1)):
            changed = list(state)
            changed[field] = value
            variants.append(env.encode(tuple(changed)))
        self.assertEqual(len(set(variants + [env.encode(state)])), 6)

    def test_config_versions_are_strict(self):
        config = load_config()
        config["reward_version"] = "v3"
        with self.assertRaises(ValueError):
            load_config(config)


class SparseQLearningTests(unittest.TestCase):
    def test_sparse_update_bootstraps_only_nonterminal_transitions(self):
        config = load_config()
        q = {2: np.array([0, 0, 10, 0, 0], dtype=np.float64)}
        error = update_q(q, 1, 0, 1.0, 2, False, False, config, 5)
        self.assertAlmostEqual(q[1][0], 0.25 * (1 + 0.97 * 10))
        self.assertAlmostEqual(error, 1 + 0.97 * 10)
        q = {2: np.array([0, 0, 10, 0, 0], dtype=np.float64)}
        update_q(q, 1, 0, 1.0, 2, False, True, config, 5)
        self.assertAlmostEqual(q[1][0], 0.25)

    def test_short_run_persists_sparse_model_and_metrics(self):
        config = load_config()
        config["training"].update({
            "episodes": 2,
            "seeds": [7],
            "evaluation_episodes": 2,
            "summary_window": 1,
        })
        with tempfile.TemporaryDirectory() as temporary:
            result = train_seed(config, seed=7, output_root=temporary)
            model_path = Path(result["model_dir"]) / "q_table.npz"
            with np.load(model_path, allow_pickle=False) as model:
                self.assertEqual(model["state_ids"].ndim, 1)
                self.assertEqual(model["values"].shape, (len(model["state_ids"]), 5))
            self.assertEqual(len(result["metrics"]), 2)
            self.assertEqual(len(result["metadata"]["observation_fields"]), 11)
            self.assertTrue(Path(result["dataset"]).is_file())


if __name__ == "__main__":
    unittest.main()
