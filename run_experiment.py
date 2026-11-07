"""Entrada común para elegir experimento sin cambiar los ejecutables de v1."""
import argparse
import subprocess
import sys
from pathlib import Path

SCRIPTS = {"rally-v1": "train.py", "rally-v2": "pipeline_v2.py", "rally-v3": "pipeline_v3.py", "rally-v4": "pipeline_v4.py", "rally-v5": "pipeline_v5.py"}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seleccionar experimento Rally")
    parser.add_argument("--environment-version", choices=list(SCRIPTS), default="rally-v1")
    args, remaining = parser.parse_known_args()
    raise SystemExit(subprocess.call([sys.executable, str(Path(__file__).resolve().parent / SCRIPTS[args.environment_version]), *remaining]))
