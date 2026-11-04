#!/usr/bin/env python3
"""Inicia o app "Inglês com Vídeo" em qualquer sistema. É o único arquivo que você precisa abrir.

  Windows:      dois cliques neste arquivo (iniciar.py)
  Mac / Linux:  no terminal, dentro desta pasta:  python3 iniciar.py

Na primeira vez cria um ambiente isolado (.venv) e instala o que o app precisa:
yt-dlp (baixa do YouTube), numpy (sincroniza a letra), imageio-ffmpeg (ffmpeg pronto
para cada sistema) e deno (runtime JavaScript que o yt-dlp usa no YouTube).
"""
import os
import shutil
import subprocess
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
VENV = os.path.join(BASE, ".venv")
WINDOWS = os.name == "nt"
PY = os.path.join(VENV, "Scripts", "python.exe") if WINDOWS else os.path.join(VENV, "bin", "python")
DEPS = ["yt-dlp[default]", "numpy", "imageio-ffmpeg", "deno"]
CHECK = "import yt_dlp, numpy, imageio_ffmpeg, deno"


class Falha(Exception):
    pass


def criar_ambiente():
    print("Preparando o ambiente (só na primeira vez, pode levar alguns minutos)...")
    import venv
    try:
        venv.create(VENV, with_pip=True)
    except Exception as e:
        shutil.rmtree(VENV, ignore_errors=True)  # não deixa um .venv pela metade
        dica = ""
        if sys.platform.startswith("linux"):
            dica = ("\nNo Ubuntu/Debian, instale o módulo de ambientes do Python e tente de novo:\n"
                    "    sudo apt install python3-venv")
        raise Falha(f"Não consegui criar o ambiente do app ({e}).{dica}")
    if not os.path.exists(PY):
        shutil.rmtree(VENV, ignore_errors=True)
        raise Falha("O ambiente do app foi criado incompleto. Tente abrir de novo.")


def main():
    if sys.version_info < (3, 9):
        raise Falha("É preciso o Python 3.9 ou mais novo: https://www.python.org/downloads/"
                    + ("\nNa instalação, marque a opção \"Add python.exe to PATH\"." if WINDOWS else ""))
    if not os.path.exists(PY):
        criar_ambiente()
    if subprocess.run([PY, "-c", CHECK], capture_output=True).returncode != 0:
        print("Instalando dependências...")
        r = subprocess.run([PY, "-m", "pip", "install", "-q", "-U", *DEPS])
        if r.returncode != 0:
            print("⚠️  Não consegui instalar as dependências (sem internet?). O app vai abrir mesmo assim.")
    os.chdir(BASE)
    code = subprocess.call([PY, os.path.join(BASE, "server.py")])
    if code != 0:
        raise Falha(f"O app fechou com erro (código {code}). Veja a mensagem acima.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Falha as e:
        print("\n❌ " + str(e))
        if WINDOWS:  # aberto com dois cliques, a janela fecharia antes de dar para ler
            input("\nAperte Enter para fechar...")
        sys.exit(1)
