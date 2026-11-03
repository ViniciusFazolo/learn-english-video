#!/usr/bin/env bash
# Inicia o app "Inglês com Música". Na primeira vez, instala o yt-dlp num ambiente isolado.
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "Preparando ambiente (só na primeira vez)..."
  python3 -m venv .venv
fi
if ! .venv/bin/python -c "import yt_dlp, numpy" 2>/dev/null; then
  .venv/bin/pip install -q -U "yt-dlp[default]" numpy || echo "Não consegui instalar as dependências (sem internet?)."
fi
exec .venv/bin/python server.py
