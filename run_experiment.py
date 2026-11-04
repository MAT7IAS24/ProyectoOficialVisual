"""Entrada común para elegir experimento sin cambiar los ejecutables de v1."""
import argparse
import subprocess
import sys
from pathlib import Path

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seleccionar experimento Rally")
    parser.add_argument("--environment-version", choices=["rally-v1", "rally-v2"], default="rally-v1")
    args, remaining = parser.parse_known_args()
    script = "train.py" if args.environment_version == "rally-v1" else "pipeline_v2.py"
    raise SystemExit(subprocess.call([sys.executable, str(Path(__file__).resolve().parent / script), *remaining]))
