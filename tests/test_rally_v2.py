import contextlib
import hashlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from gymnasium.utils.env_checker import check_env

from environments import make_env
from race_env_v2 import RallyV2Env, load_config
from training_v2 import ROOT, train_seed, update_q, epsilon_at


class EnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.env = RallyV2Env()
        self.env.reset(seed=7)

    def test_gymnasium_and_spaces(self):
        check_env(self.env, skip_render_check=True)
        obs, info = self.env.reset(seed=7)
        self.assertEqual(obs, (0, 0, 3, 0))
        self.assertEqual(self.env.state_shape, (11, 4, 4, 3))
        self.assertEqual(self.env.action_space.n, 3)
        self.assertEqual(info['termination_cause'], 'en_curso')

    def test_speed_fuel_reward_and_multiple_traversed_segments(self):
        obs, reward, term, trunc, info = self.env.step(2)
        self.assertEqual(obs, (1, 1, 3, 0))
        self.assertAlmostEqual(reward, .75)
        self.assertEqual(info['fuel'], 95)
        obs, reward, _, _, info = self.env.step(2)
        self.assertEqual(obs, (3, 2, 3, 1))
        self.assertEqual(info['newly_rewarded_segments'], [2, 3])
        self.assertAlmostEqual(reward, 2.6)

    def test_every_crossed_curve_is_checked(self):
        self.env.position_meters = 500
        self.env.speed_level = 2
        obs, reward, term, trunc, info = self.env.step(2)
        self.assertEqual(info['position_meters'], 600)
        self.assertEqual(info['speed_level'], 0)
        self.assertEqual(info['fuel_consumed'], 11)
        self.assertEqual(info['off_track_count'], 1)
        self.assertEqual(info['newly_rewarded_segments'], [6])
        self.assertNotIn(7, self.env.rewarded_segments)
        self.assertAlmostEqual(reward, -7.55)

    def test_dry_curve_threshold(self):
        self.env.position_meters = 200
        self.env.speed_level = 2
        _, reward, _, _, info = self.env.step(2)
        self.assertEqual(info['position_meters'], 200)
        self.assertEqual(info['off_track_count'], 1)
        self.assertAlmostEqual(reward, -9.55)

    def test_rewards_never_repeat_after_rollback(self):
        for action in (2, 2, 2):
            self.env.step(action)  # reaches 3; unsafe entry 4 returns to 3
        self.assertEqual(self.env.position_meters, 300)
        self.env.step(2)  # valid 4
        self.env.position_meters = 300  # revisit after a rollback
        _, _, _, _, info = self.env.step(1)
        self.assertEqual(info['newly_rewarded_segments'], [])
        self.assertEqual(info['reward_components']['new_segments'], 0)

    def test_third_off_track_terminates(self):
        self.env.position_meters = 600
        self.env.speed_level = 1
        self.env.off_track_count = 2
        _, _, terminated, truncated, info = self.env.step(2)
        self.assertTrue(terminated)
        self.assertFalse(truncated)
        self.assertEqual(info['termination_cause'], 'salidas_de_pista')

    def test_out_of_fuel_and_no_step_after_done(self):
        for _ in range(50):
            obs, reward, terminated, truncated, info = self.env.step(1)
        self.assertTrue(terminated)
        self.assertFalse(truncated)
        self.assertEqual(info['fuel'], 0)
        self.assertEqual(info['termination_cause'], 'sin_combustible')
        with self.assertRaises(RuntimeError):
            self.env.step(1)

    def test_time_limit_is_distinct_from_termination(self):
        config = load_config()
        config['environment']['fuel_base_cost'] = 0
        env = RallyV2Env(config)
        env.reset()
        for _ in range(50):
            _, _, term, trunc, info = env.step(1)
        self.assertFalse(term)
        self.assertTrue(trunc)
        self.assertEqual(info['termination_cause'], 'limite_pasos')

    def test_goal_precedes_empty_fuel(self):
        self.env.position_meters = 900
        self.env.speed_level = 1
        self.env.fuel = 2
        _, reward, term, trunc, info = self.env.step(1)
        self.assertTrue(term)
        self.assertFalse(trunc)
        self.assertEqual(info['termination_cause'], 'vuelta_completada')
        self.assertAlmostEqual(reward, 20.9)

    def test_safe_lap_fuel_bonus(self):
        total = 0
        for action in [2] + [1] * 9:
            _, reward, term, trunc, info = self.env.step(action)
            total += reward
        self.assertEqual(info['fuel'], 50)
        self.assertEqual(info['position_meters'], 1000)
        self.assertAlmostEqual(total, 32.5)

    def test_bucket_inclusive_boundaries_and_reset(self):
        for fuel, bucket in [(0,0), (25,0), (26,1), (50,1), (51,2), (75,2), (76,3), (100,3)]:
            self.env.fuel = fuel
            self.assertEqual(self.env.observation()[2], bucket)
        self.env.reset()
        self.assertEqual(self.env.rewarded_segments, {0})
        self.assertEqual(self.env.off_track_count, 0)
        self.assertEqual(self.env.steps, 0)

    def test_brake_stationary_cost_and_action_validation(self):
        obs, reward, _, _, info = self.env.step(0)
        self.assertEqual(obs[:2], (0,0))
        self.assertAlmostEqual(reward, -1.1)
        self.assertEqual(info['fuel'], 98)
        for invalid in (-1, 3, 'acelerar'):
            with self.assertRaises(ValueError):
                self.env.step(invalid)

    def test_config_is_used_and_invalid_config_rejected(self):
        config = load_config()
        config['reward']['new_segment'] = 4
        env = RallyV2Env(config)
        config['reward']['new_segment'] = 999
        env.reset()
        self.assertAlmostEqual(env.step(2)[1], 2.75)
        config['training']['alpha'] = 2
        with self.assertRaises(ValueError):
            RallyV2Env(config)


class TrainingTests(unittest.TestCase):
    def test_bootstrap_and_epsilon_endpoints(self):
        config=load_config()
        self.assertEqual(epsilon_at(1, config), 1)
        self.assertAlmostEqual(epsilon_at(3000, config), .05)
        q=np.zeros((528,3));q[1]=10
        update_q(q,0,0,-1,1,False,config)
        self.assertAlmostEqual(q[0,0], 2.125)
        update_q(q,2,0,-1,1,True,config)
        self.assertAlmostEqual(q[2,0], -.25)

    def test_training_reproducible_and_independent(self):
        config=load_config();config['training']['episodes']=20
        with tempfile.TemporaryDirectory() as root:
            a=train_seed(config,7,root);b=train_seed(config,7,root);c=train_seed(config,21,root)
            self.assertEqual(a['metadata']['dataset_sha256'],b['metadata']['dataset_sha256'])
            self.assertEqual(a['metadata']['model_sha256'],b['metadata']['model_sha256'])
            self.assertNotEqual(a['metadata']['dataset_sha256'],c['metadata']['dataset_sha256'])
            self.assertNotEqual(a['experiment_id'],b['experiment_id'])
            self.assertEqual(np.load(Path(a['model_dir'])/'q_table.npy').shape,(528,3))

    def test_v1_source_and_model_unchanged(self):
        expected={
            'race_env.py':'576b958f36f195634edbe94e0c80778984158e96b06af3e8937d9d6fb7aef6f9',
            'train.py':'5af3533ce908929ab55bf475a8e70659c23c0d9f8e70631a43f2ca87f462f940',
            'pipeline.py':'8d62ea487c226e965c843ae4da77fd229b3590a7ac5b201ae2fa912439d3787b',
            'rally-dashboard/dist/app.js':'603c44f9007a912abba83847c5f06e722438ed80b043dc21faf7a50194616743'}
        for path, sha in expected.items():
            self.assertEqual(hashlib.sha256((ROOT/path).read_bytes()).hexdigest(),sha)
        env=make_env('rally-v1');env.reset();self.assertEqual(env.step(1)[0],1);self.assertEqual(env.step(0)[0],0)
        import train
        captured=[]
        with patch('sys.argv',['train.py','--episodes','25','--seed','7','--delay','0']), patch.object(train,'render_dashboard',side_effect=lambda **kw:captured.append(kw['q_table'].copy())), contextlib.redirect_stdout(io.StringIO()):
            train.main()
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'q.npy';np.save(path,captured[-1],allow_pickle=False)
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),'6117f485366c879b7040dcaabf5c5c3bae2a6a7fca8bf2037039ad4dd75a83a3')


if __name__ == '__main__':
    unittest.main()
