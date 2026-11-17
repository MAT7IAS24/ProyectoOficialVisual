"""Prueba de recuperación y rollback: los modelos publicados (el recomendado del N8 y el histórico del N7)
se recuperan desde su paquete con hashes válidos y dan exactamente el mismo resultado guardado."""
import contextlib
import io
import unittest

import recuperar_modelo


class Recuperacion(unittest.TestCase):
    def check(self, folder):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = recuperar_modelo.main([folder, "--pistas", "2"])
        self.assertEqual(code, 0, out.getvalue())

    def test_modelo_recomendado_n8(self):
        self.check("rally-dashboard/dist/modelos/n8/ppo-recomendado")

    def test_rollback_a_modelo_historico_n7(self):
        self.check("rally-dashboard/dist/modelos/n7/ppo-recomendado")


if __name__ == "__main__":
    unittest.main()
