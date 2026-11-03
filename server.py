#!/usr/bin/env python3
"""Servidor local do app "Inglês com Música".

- Serve a interface (pasta static/)
- /api/status            -> informa se o yt-dlp está disponível
- /api/lyrics?q=...      -> busca letras sincronizadas no LRCLIB
- /api/audio?q=...&duration=...  -> baixa o áudio do YouTube (yt-dlp) para cache/
- /cache/<arquivo>       -> entrega o áudio baixado
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")
CACHE = os.path.join(BASE, "cache")
PORT = int(os.environ.get("PORT", "8765"))
UA = "InglesComMusica/1.0 (app local de estudo)"

os.makedirs(CACHE, exist_ok=True)
DATA = os.path.join(BASE, "dados")  # dados do usuário (não é cache: não apagar)
os.makedirs(DATA, exist_ok=True)
NOTES_FILE = os.path.join(DATA, "anotacoes.json")
_notes_guard = threading.Lock()


def load_notes():
    try:
        return json.load(open(NOTES_FILE, encoding="utf-8"))
    except (OSError, ValueError):
        return []


def save_notes(notes):
    tmp = NOTES_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(notes, f, ensure_ascii=False, indent=1)
    os.replace(tmp, NOTES_FILE)  # grava inteiro de uma vez, sem corromper o arquivo
_locks = {}
_locks_guard = threading.Lock()


def ytdlp_cmd():
    try:
        import yt_dlp  # noqa: F401
        return [sys.executable, "-m", "yt_dlp"]
    except ImportError:
        exe = shutil.which("yt-dlp")
        return [exe] if exe else None


_ffmpeg_path = None


def ffmpeg_exe():
    """ffmpeg do sistema, ou o que vem no pacote imageio-ffmpeg (funciona em Windows, Mac e Linux).
    O yt-dlp reconhece o programa pelo nome do arquivo, então copiamos o binário do pacote
    para .ffmpeg/ffmpeg(.exe) uma única vez."""
    global _ffmpeg_path
    if _ffmpeg_path and os.path.exists(_ffmpeg_path):
        return _ffmpeg_path
    found = shutil.which("ffmpeg")
    if not found:
        try:
            import imageio_ffmpeg
            src = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            return None
        dest_dir = os.path.join(BASE, ".ffmpeg")
        found = os.path.join(dest_dir, "ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        if not os.path.exists(found) or os.path.getsize(found) != os.path.getsize(src):
            os.makedirs(dest_dir, exist_ok=True)
            shutil.copy2(src, found + ".tmp")
            os.replace(found + ".tmp", found)
            if os.name != "nt":
                os.chmod(found, 0o755)
    _ffmpeg_path = found
    return found


def js_runtime():
    """Versões recentes do yt-dlp precisam de um runtime JS para o YouTube.
    Usa deno/node do sistema ou o deno que vem no pacote "deno" do pip."""
    if shutil.which("deno"):
        return ["--js-runtimes", "deno"]
    try:
        import deno
        return ["--js-runtimes", "deno:" + deno.find_deno_bin()]
    except Exception:
        pass
    if shutil.which("node"):
        return ["--js-runtimes", "node"]
    return []


def ytdlp_extra():
    extra = ["--encoding", "utf-8"] + js_runtime()
    ff = ffmpeg_exe()
    if ff:
        extra += ["--ffmpeg-location", ff]
    return extra


def http_json(url, tries=4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(1.5 * (i + 1))
                continue
            raise
        except Exception as e:  # rede instável
            last = e
            time.sleep(1.0 * (i + 1))
    raise last


BAD_WORDS = ["live", "ao vivo", "cover", "karaoke", "8d", "slowed", "sped up",
             "nightcore", "remix", "reverb", "instrumental", "tutorial", "reaction",
             "lyrics", "lyric video", "letra", "legendado", "tradução", "traducao"]


def pick_video(entries, query, duration):
    q = query.lower()
    best, best_score = None, None
    for i, e in enumerate(entries):
        if not e or not e.get("id"):
            continue
        title = (e.get("title") or "").lower()
        d = e.get("duration") or 0
        score = i * 2.0  # leve preferência pela ordem do YouTube
        if duration and d:
            score += abs(d - duration)
        elif duration:
            score += 30
        for w in BAD_WORDS:
            if w in title and w not in q:
                score += 60
        if best_score is None or score < best_score:
            best, best_score = e, score
    return best


def yt_info(url):
    cmd = ytdlp_cmd()
    if not cmd:
        raise RuntimeError("yt-dlp não está instalado. Abra o app pelo iniciar.py (ele instala o que falta).")
    r = subprocess.run(cmd + ytdlp_extra() + ["-J", "--no-warnings", "--no-playlist", url],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    if r.returncode != 0:
        err = r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "erro desconhecido"
        if "not a bot" in err:
            raise RuntimeError("o YouTube bloqueou temporariamente os downloads deste computador "
                               "(“confirme que não é um robô”). Espere um pouco e tente de novo")
        raise RuntimeError(err[-300:])
    return json.loads(r.stdout)


def yt_download(info, out_base, audio_only=False, sub=None, height=480):
    """Baixa a partir do info já extraído (sem extrair de novo). sub = (idioma, automática?)."""
    cmd = ytdlp_cmd()
    info_path = out_base + ".info.json"
    json.dump(info, open(info_path, "w", encoding="utf-8"))
    # Áudio AAC (mp4a): o YouTube às vezes oferece Dolby (E-AC3), que o navegador não toca.
    aud = "ba[acodec^=mp4a]/ba[acodec=opus]/ba[acodec!=eac3][acodec!=ac3]"
    vid = f"bv*[height<={height}][vcodec^=avc1]/bv*[height<={height}][ext=mp4]"
    if not audio_only and not ffmpeg_exe():
        # O YouTube entrega vídeo e áudio separados; sem ffmpeg o yt-dlp não junta e o navegador não toca.
        raise RuntimeError("o ffmpeg não foi encontrado. Feche o app e abra de novo pelo iniciar.py "
                           "(ele instala o que falta)")
    fmt = aud if audio_only else f"({vid})+({aud})/b[height<={height}][acodec^=mp4a]/b[height<={height}]"
    args = cmd + ytdlp_extra() + ["--load-info-json", info_path, "-f", fmt, "--no-warnings",
                                  "-o", out_base + ".%(ext)s", "--print", "after_move:filepath"]
    if not audio_only:
        args += ["--merge-output-format", "mp4"]
    if sub:
        args += ["--write-auto-subs" if sub[1] else "--write-subs", "--sub-langs", sub[0],
                 "--sub-format", "json3", "-o", "subtitle:" + out_base + ".sub.%(ext)s"]
    try:
        dl = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800)
    finally:
        os.remove(info_path)
    if dl.returncode != 0:
        raise RuntimeError("Falha ao baixar: " + dl.stderr.strip()[-400:])
    return dl.stdout.strip().splitlines()[-1]


_search_cache = {}


def thumb(vid):
    return f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg"


def yt_search(query, n=6):
    key = (query.lower().strip(), n)
    if key in _search_cache:
        return _search_cache[key]
    cmd = ytdlp_cmd()
    if not cmd:
        raise RuntimeError("yt-dlp não está instalado. Abra o app pelo iniciar.py (ele instala o que falta).")
    r = subprocess.run(cmd + ytdlp_extra() + ["-J", "--flat-playlist", "--no-warnings", f"ytsearch{n}:{query}"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
    if r.returncode != 0:
        raise RuntimeError("Falha ao buscar no YouTube: " + r.stderr.strip()[-400:])
    out = []
    for e in json.loads(r.stdout).get("entries") or []:
        if not e or not e.get("id") or len(e["id"]) != 11:
            continue  # pula canais/playlists
        out.append({"id": e["id"], "title": e.get("title") or "", "channel": e.get("channel") or e.get("uploader") or "",
                    "duration": e.get("duration") or 0, "thumb": thumb(e["id"]),
                    "live": e.get("live_status") == "is_live"})
    _search_cache[key] = out
    return out


def song_video(query, duration):
    """O vídeo que será usado para a música (mesma escolha do download)."""
    v = pick_video(yt_search(query), query, duration)
    if not v:
        raise RuntimeError("Nenhum vídeo encontrado para essa música.")
    return v


def download_audio(query, duration, vid=""):
    key = hashlib.sha1(("video:" + query.lower().strip()).encode()).hexdigest()[:16]
    with _locks_guard:
        lock = _locks.setdefault(key, threading.Lock())
    with lock:
        meta_path = os.path.join(CACHE, key + ".json")
        if os.path.exists(meta_path):
            meta = json.load(open(meta_path, encoding="utf-8"))
            if os.path.exists(os.path.join(CACHE, meta["file"])):
                return meta
        if not re.fullmatch(r"[\w-]{11}", vid or ""):
            vid = song_video(query, duration)["id"]
        url = "https://www.youtube.com/watch?v=" + vid
        info = yt_info(url)
        path = yt_download(info, os.path.join(CACHE, key))
        meta = {"file": os.path.basename(path), "title": info.get("title"),
                "duration": info.get("duration"), "youtube": url, "thumb": thumb(vid)}
        json.dump(meta, open(meta_path, "w", encoding="utf-8"))
        return meta


# ---------------- vídeos quaisquer (filmes, podcasts...) com a legenda do YouTube ----------------
LONG_VIDEO = 20 * 60  # acima disso (filmes, podcasts) baixa em 360p para não pesar tanto


def pick_sub(info):
    """Prefere legenda feita pelo canal; senão a automática no idioma original (inglês)."""
    manual = info.get("subtitles") or {}
    for lang in ["en", "en-US", "en-GB", "en-CA", "en-AU"] + sorted(manual):
        if lang in manual and lang.lower().startswith("en") and "live_chat" not in lang:
            return lang, False
    auto = info.get("automatic_captions") or {}
    if "en-orig" in auto:
        return "en-orig", True
    if "en" in auto and (info.get("language") or "en").lower().startswith("en"):
        return "en", True
    return None


NOISE = re.compile(r"\[[^\]]*\]|\([^)]*(?:music|applause|laugh|inaudible|risos|música)[^)]*\)|♪+|♫+|>>+|&gt;&gt;", re.I)
SPEAKER = re.compile(r"^(?:-\s*)?(?:[A-Z][A-Z .'\-]{1,24}):\s*")


def sub_words(path):
    """Lista de (tempo_em_s, palavra, início_de_legenda) a partir do json3 do YouTube."""
    data = json.load(open(path, encoding="utf-8"))
    words = []
    for ev in data.get("events") or []:
        segs = ev.get("segs")
        if not segs:
            continue
        t0 = ev.get("tStartMs", 0) / 1000
        dur = (ev.get("dDurationMs") or 2000) / 1000
        if any("tOffsetMs" in sg for sg in segs[1:]):  # automática: tempo por palavra
            for sg in segs:
                ws = NOISE.sub("", sg.get("utf8", "")).split()
                for k, w in enumerate(ws):  # às vezes um pedaço traz 2 palavras com um tempo só
                    words.append((t0 + sg.get("tOffsetMs", 0) / 1000 + 0.15 * k, w, False))
            continue
        text = "".join(sg.get("utf8", "") for sg in segs)
        if not ev.get("segs") or not text.strip():
            continue
        cue_lines = [SPEAKER.sub("", ln.strip()) for ln in text.split("\n")]
        text = NOISE.sub(" ", " ".join(cue_lines))
        toks = [w for w in text.split() if re.search(r"[A-Za-z0-9]", w)]
        if not toks:
            continue
        total = sum(len(w) + 1 for w in toks)
        acc = 0
        for i, w in enumerate(toks):  # legenda manual: espalha as palavras pela duração da legenda
            words.append((t0 + dur * 0.9 * acc / total, w, i == 0))
            acc += len(w) + 1
    words.sort(key=lambda x: x[0])
    return words


def words_to_lines(words, manual):
    lines, cur = [], []

    def close(next_t):
        if not cur:
            return
        last_t, last_w = cur[-1][0], cur[-1][1]
        est = last_t + 0.25 + 0.065 * len(last_w)  # quando a última palavra termina
        end = min(est + 0.15, next_t - 0.05) if next_t else est + 0.3
        text = " ".join(w for _, w, _ in cur)
        if not manual:
            text = re.sub(r"\bi\b", "I", text)
        text = text[0].upper() + text[1:]
        lines.append({"start": round(cur[0][0], 2), "end": round(max(end, cur[0][0] + 0.6), 2), "text": text,
                      "wt": [round(t, 2) for t, _, _ in cur]})  # quando cada palavra começa
        cur.clear()

    for t, w, cue_start in words:
        if cur:
            gap = t - cur[-1][0]
            n = len(cur)
            prev_w = cur[-1][1]
            sentence_end = manual and re.search(r"[.?!…]['\"”’)]*$", prev_w) \
                and not re.fullmatch(r"(Mr|Mrs|Ms|Dr|St|vs)\.", prev_w)
            if (sentence_end and n >= 2) or gap > 1.5 or (n >= 4 and gap > 0.7) or \
               (manual and cue_start and n >= 10 and re.search(r"[,;:]$", prev_w)) or \
               n >= 16 or t - cur[0][0] > 9:
                close(t)
        cur.append((t, w, cue_start))
    close(None)
    # junta "frases" de uma palavra só à seguinte, quando bem próximas
    out = []
    for L in lines:
        if out and len(out[-1]["text"].split()) == 1 and L["start"] - out[-1]["end"] < 0.8 \
                and len(L["text"].split()) < 12:
            out[-1] = {"start": out[-1]["start"], "end": L["end"], "text": out[-1]["text"] + " " + L["text"],
                       "wt": out[-1]["wt"] + L["wt"]}
        else:
            out.append(L)
    return out


def download_video(vid):
    if not re.fullmatch(r"[\w-]{11}", vid or ""):
        raise RuntimeError("Link do YouTube inválido.")
    key = "yt_" + vid
    with _locks_guard:
        lock = _locks.setdefault(key, threading.Lock())
    with lock:
        meta_path = os.path.join(CACHE, key + ".json")
        if os.path.exists(meta_path):
            meta = json.load(open(meta_path, encoding="utf-8"))
            if os.path.exists(os.path.join(CACHE, meta["file"])):
                return meta
        info = yt_info("https://www.youtube.com/watch?v=" + vid)
        if info.get("is_live") or info.get("live_status") == "is_live":
            raise RuntimeError("Transmissões ao vivo não funcionam. Escolha um vídeo já gravado.")
        sub = pick_sub(info)
        if not sub:
            raise RuntimeError("Esse vídeo não tem legenda em inglês (nem a automática do YouTube).")
        dur = info.get("duration") or 0
        base = os.path.join(CACHE, key)
        path = yt_download(info, base, sub=sub, height=360 if dur > LONG_VIDEO else 480)
        sub_file = next((os.path.join(CACHE, f) for f in os.listdir(CACHE)
                         if f.startswith(key + ".sub.") and f.endswith(".json3")), None)
        if not sub_file:
            raise RuntimeError("Não consegui baixar a legenda desse vídeo.")
        lines = words_to_lines(sub_words(sub_file), manual=not sub[1])
        os.remove(sub_file)
        # tira "frases" que são só ruído da legenda automática (ex.: "E")
        lines = [L for L in lines if len(re.sub(r"[^A-Za-z0-9]", "", L["text"])) >= 2]
        if not lines:
            raise RuntimeError("A legenda desse vídeo está vazia.")
        meta = {"file": os.path.basename(path), "title": info.get("title") or "", "id": vid,
                "channel": info.get("channel") or info.get("uploader") or "", "duration": dur,
                "thumb": thumb(vid), "subs": "auto" if sub[1] else "manual", "audioOnly": False,
                "lines": lines}
        json.dump(meta, open(meta_path, "w", encoding="utf-8"), ensure_ascii=False)
        return meta


# ---------------- sincronia automática ----------------
# A letra do LRCLIB costuma estar sincronizada com a versão do álbum. O clipe pode ter
# introdução/cenas extras. Baixamos o áudio da versão com a mesma duração da letra e
# comparamos o "ritmo" (picos de energia) dos dois áudios para achar o deslocamento.
FRAME = 0.025  # segundos por quadro do envelope


BANDS = [0, 150, 300, 600, 1000, 1600, 2400, 3200, 4000]  # Hz


def envelope(path):
    """Para cada quadro de 25 ms, mede onde o som "ataca" em 8 faixas de frequência
    (graves, médios, agudos...). Comparar faixas separadas deixa cada trecho bem mais
    único do que só o volume geral, evitando confundir partes repetidas da música."""
    import numpy as np
    sr, nfft, hop = 8000, 512, int(8000 * FRAME)
    r = subprocess.run([ffmpeg_exe() or "ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
                       capture_output=True, timeout=180)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg falhou: " + r.stderr.decode(errors="ignore")[-200:])
    x = np.frombuffer(r.stdout, dtype=np.float32)
    n = 1 + (len(x) - nfft) // hop
    if n < 10:
        raise RuntimeError("áudio curto demais")
    win = np.hanning(nfft).astype(np.float32)
    freqs = np.fft.rfftfreq(nfft, 1 / sr)
    masks = [(freqs >= lo) & (freqs < hi) for lo, hi in zip(BANDS, BANDS[1:])]
    bands = np.empty((n, len(masks)), dtype=np.float32)
    for start in range(0, n, 4000):  # em blocos, para não usar memória demais
        idx = np.arange(nfft)[None, :] + hop * np.arange(start, min(n, start + 4000))[:, None]
        spec = np.abs(np.fft.rfft(x[idx] * win, axis=1)) ** 2
        for j, m in enumerate(masks):
            bands[start:start + len(idx), j] = np.log(spec[:, m].sum(1) + 1e-6)
    onset = np.maximum(0, np.diff(bands, axis=0))
    return (onset - onset.mean(0)) / (onset.std(0) + 1e-9)


def chunk_offsets(ref, vid, win=12.0, step=4.0):
    """Procura cada trecho de 12 s da referência dentro do vídeo.
    Retorna [(tempo_na_referência, deslocamento, semelhança 0..1)]."""
    import numpy as np
    w, st = int(win / FRAME), int(step / FRAME)
    if len(vid) <= w or len(ref) <= w:
        return []
    nb = ref.shape[1]
    n = 1 << int(np.ceil(np.log2(len(vid) + w)))
    V = np.fft.rfft(vid, n, axis=0)
    cs = np.concatenate([np.zeros((1, nb)), np.cumsum(vid.astype(np.float64) ** 2, axis=0)])
    energy = np.sqrt((cs[w:] - cs[:-w]).sum(1) + 1e-9)
    out = []
    for i in range(0, len(ref) - w, st):
        a = ref[i:i + w]
        a = (a - a.mean(0)) / (a.std(0) + 1e-9)
        c = np.fft.irfft((V * np.conj(np.fft.rfft(a, n, axis=0))).sum(1), n)[: len(energy)]
        c = c / (energy[: len(c)] * np.sqrt(w * nb))
        k = int(np.argmax(c))
        out.append(((i + w / 2) * FRAME, (k - i) * FRAME, float(c[k])))
    return out


def build_map(chunks, min_run=3):
    """Agrupa trechos seguidos com o mesmo deslocamento. Só vale um grupo com pelo menos
    3 trechos (12 s+): saltos curtos são refrões confundidos, grupos longos são cenas
    extras reais no clipe. Devolve (mapa, fração aproveitada, semelhança média)."""
    import numpy as np
    if not chunks:
        return [], 0.0, 0.0
    runs, cur = [], []
    for t, o, c in chunks:
        if c > 0.4 and cur and abs(o - cur[-1][1]) <= 0.3:
            cur.append((t, o, c))
        else:
            if cur:
                runs.append(cur)
            cur = [(t, o, c)] if c > 0.4 else []
    if cur:
        runs.append(cur)
    good = [x for r in runs if len(r) >= min_run for x in r]
    if not good:
        return [], 0.0, 0.0
    return ([[round(t, 2), round(o, 2)] for t, o, _ in good], len(good) / len(chunks),
            float(np.mean([c for *_, c in good])))


NEUTRAL = {"official", "audio", "hq", "hd", "remastered", "remaster", "original", "the", "a", "ft", "feat"}


def ref_score(e, artist, track, duration):
    import re
    channel = (e.get("channel") or e.get("uploader") or "").lower()
    title = (e.get("title") or "").lower()
    q = f"{artist} {track}".lower()
    known = set(re.findall(r"[a-z0-9']+", q)) | NEUTRAL
    extra = [w for w in re.findall(r"[a-z0-9']+", title) if w not in known | {"lyrics", "lyric"}]
    s = 12 * len(extra)  # quanto mais "limpo" o título, mais provável ser a versão de estúdio
    if not (channel.endswith(" - topic") or artist.lower() in channel):
        s += 25
    # uploads "(Lyrics)" normalmente usam o áudio do álbum: servem bem de referência
    ref_bad = [w for w in BAD_WORDS if w not in ("lyrics", "lyric video", "letra")]
    for w in ref_bad + ["video", "vídeo", "clipe", "extended", "acoustic", "version", "edit", "cover", "8d"]:
        if w in title and w not in q:
            s += 60
    return s + (abs(e["duration"] - duration) * 0.05 if duration else 0)


def align(artist, track, duration, video_file):
    cmd = ytdlp_cmd()
    if not cmd:
        raise RuntimeError("yt-dlp não está instalado")
    video_path = os.path.join(CACHE, os.path.basename(video_file))
    if not os.path.isfile(video_path):
        raise RuntimeError("vídeo não encontrado")
    key = hashlib.sha1(f"align5:{video_file}:{artist}:{track}".lower().encode()).hexdigest()[:16]
    meta_path = os.path.join(CACHE, key + ".align.json")
    if os.path.exists(meta_path):
        return json.load(open(meta_path, encoding="utf-8"))
    video_meta = os.path.join(CACHE, os.path.splitext(os.path.basename(video_file))[0] + ".json")
    video_id = json.load(open(video_meta, encoding="utf-8")).get("youtube", "").split("v=")[-1] if os.path.exists(video_meta) else ""
    with _locks_guard:
        lock = _locks.setdefault(key, threading.Lock())
    with lock:
        if os.path.exists(meta_path):
            return json.load(open(meta_path, encoding="utf-8"))
        extra = ytdlp_extra()
        entries, seen = [], {video_id}
        for q in (f"{artist} {track}", f"{artist} {track} audio"):
            search = subprocess.run(cmd + extra + ["-J", "--flat-playlist", "--no-warnings", f"ytsearch10:{q}"],
                                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
            if search.returncode != 0:
                continue
            for e in json.loads(search.stdout).get("entries") or []:
                if e and e.get("duration") and e.get("id") not in seen and e["duration"] < 900:
                    seen.add(e["id"])
                    entries.append(e)
        entries.sort(key=lambda e: ref_score(e, artist, track, duration))
        vid = envelope(video_path)
        tried = []
        for ref in entries[:3]:  # testa até 3 candidatas, da mais provável para a menos
            out = os.path.join(CACHE, key + ".ref.%(ext)s")
            dl = subprocess.run(cmd + extra + ["-f", "bestaudio", "--no-playlist", "--no-warnings", "-o", out,
                                               "--print", "after_move:filepath",
                                               "https://www.youtube.com/watch?v=" + ref["id"]],
                                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
            if dl.returncode != 0:
                continue
            ref_path = dl.stdout.strip().splitlines()[-1]
            try:
                mapping, frac, sim = build_map(chunk_offsets(envelope(ref_path), vid))
            finally:
                try:
                    os.remove(ref_path)
                except OSError:
                    pass
            tried.append(f"{ref.get('title')}: {frac:.0%}")
            print(f"[sincronia] {ref.get('title')!r}: {frac:.0%} dos trechos concordam, semelhança {sim:.2f}")
            if frac >= 0.5 and sim >= 0.45:
                offs = sorted(o for _, o in mapping)
                result = {"offset": offs[len(offs) // 2], "map": mapping, "agree": round(frac, 2),
                          "similarity": round(sim, 2), "reference": ref.get("title")}
                json.dump(result, open(meta_path, "w", encoding="utf-8"))
                return result
        raise RuntimeError("nenhuma versão de referência bateu com o vídeo (" + "; ".join(tried) + ")")


EXPLAIN_FILE = os.path.join(CACHE, "explicacoes.json")
_explain_cache = json.load(open(EXPLAIN_FILE, encoding="utf-8")) if os.path.exists(EXPLAIN_FILE) else {}
_explain_guard = threading.Lock()
_claude_slots = threading.Semaphore(2)

PROMPT = """Você é um professor de inglês para brasileiros. Abaixo há uma frase de "{track}" ({artist}), que pode ser uma música, filme, série ou podcast.
Frase anterior (contexto): "{prev}"
FRASE: "{text}"

Responda SOMENTE com um JSON válido, sem markdown, neste formato:
{{"traducao": "tradução natural da FRASE para o português do Brasil",
 "explicacao": "1 ou 2 frases curtas em português explicando o sentido, gírias, contrações ou expressões da FRASE",
 "expressoes": [{{"en": "expressão ou palavra importante da frase", "pt": "significado"}}],
 "exemplos": [{{"en": "exemplo curto do dia a dia usando a expressão principal da frase", "pt": "tradução"}}]}}
Use de 0 a 3 itens em "expressoes" e exatamente 3 itens em "exemplos". Os exemplos devem ser situações comuns do cotidiano (trabalho, casa, amigos, viagem)."""


WORD_PROMPT = """Você é um professor de inglês para brasileiros. Em "{track}" ({artist}) aparece a frase:
"{line}"
O aluno perguntou o que significa: "{word}"

Responda SOMENTE com um JSON válido, sem markdown, neste formato:
{{"termo": "a palavra ou expressão perguntada, na forma em que aparece",
 "pronuncia": "pronúncia aproximada escrita para brasileiros, com a sílaba forte em maiúsculas (ex.: bi-LÍ-ver)",
 "classe": "classe gramatical em português (verbo, substantivo, gíria, expressão...)",
 "significado": "o que significa NESTA frase, em português, curto e claro",
 "nota": "observação útil e curta (forma base do verbo, contração, gíria, falso cognato) ou string vazia",
 "outros": ["outros significados comuns, em português"],
 "exemplos": [{{"en": "exemplo curto do dia a dia", "pt": "tradução"}}]}}
Use de 0 a 3 itens em "outros" e exatamente 2 itens em "exemplos". Se o termo não estiver na frase, explique o sentido mais comum."""


def run_claude(prompt):
    exe = shutil.which("claude")
    if not exe:
        raise RuntimeError("claude não encontrado")
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")}
    with _claude_slots:
        r = subprocess.run([exe, "-p", "--model", "haiku", "--tools", ""], input=prompt,
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90, cwd=CACHE, env=env)
    out = r.stdout
    if r.returncode != 0 or "{" not in out:
        raise RuntimeError((r.stderr or out).strip()[-300:])
    data = json.loads(out[out.index("{"): out.rindex("}") + 1])
    data["fonte"] = "claude"
    return data


def claude_explain(text, prev, artist, track):
    return run_claude(PROMPT.format(text=text, prev=prev, artist=artist, track=track))


def mymemory_translate(text):
    url = ("https://api.mymemory.translated.net/get?langpair=en|pt-BR&q="
           + urllib.parse.quote(text))
    d = http_json(url, tries=2)
    return {"traducao": d["responseData"]["translatedText"], "explicacao": "",
            "expressoes": [], "exemplos": [], "fonte": "mymemory"}


def explain(text, prev, artist, track):
    key = text.strip().lower()
    with _explain_guard:
        lock = _locks.setdefault("ex:" + key, threading.Lock())
    with lock:
        if key in _explain_cache:
            return _explain_cache[key]
        try:
            data = claude_explain(text, prev, artist, track)
        except Exception as e:
            print("Explicação via Claude falhou, usando só tradução:", e)
            data = mymemory_translate(text)
        if data.get("fonte") == "claude":
            with _explain_guard:
                _explain_cache[key] = data
                json.dump(_explain_cache, open(EXPLAIN_FILE, "w", encoding="utf-8"), ensure_ascii=False)
        return data


def word_meaning(word, line, artist, track):
    word = " ".join(word.split())[:80]
    key = "w:" + word.lower() + "|" + line.strip().lower()
    with _explain_guard:
        lock = _locks.setdefault(key, threading.Lock())
    with lock:
        if key in _explain_cache:
            return _explain_cache[key]
        try:
            data = run_claude(WORD_PROMPT.format(word=word, line=line, artist=artist, track=track))
        except Exception as e:
            print("Significado da palavra via Claude falhou, usando só tradução:", e)
            t = mymemory_translate(word)
            data = {"termo": word, "significado": t["traducao"], "fonte": "mymemory"}
        if data.get("fonte") == "claude":
            with _explain_guard:
                _explain_cache[key] = data
                json.dump(_explain_cache, open(EXPLAIN_FILE, "w", encoding="utf-8"), ensure_ascii=False)
        return data


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".css": "text/css; charset=utf-8",
                      ".js": "text/javascript; charset=utf-8",
                      ".html": "text/html; charset=utf-8"}

    def end_headers(self):
        # sempre confere se a interface mudou (evita o navegador usar app.js/style.css antigos)
        if not self.path.startswith("/cache/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # silencioso

    def send_json(self, obj, code=200):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        try:
            if u.path == "/api/status":
                return self.send_json({"ytdlp": ytdlp_cmd() is not None})
            if u.path == "/api/lyrics":
                q = qs.get("q", "").strip()
                if not q:
                    return self.send_json([])
                res = http_json("https://lrclib.net/api/search?q=" + urllib.parse.quote(q))
                keep = ["id", "trackName", "artistName", "albumName", "duration",
                        "instrumental", "syncedLyrics"]
                return self.send_json([{k: r.get(k) for k in keep} for r in res])
            if u.path == "/api/explain":
                return self.send_json(explain(qs.get("text", ""), qs.get("prev", ""),
                                              qs.get("artist", ""), qs.get("track", "")))
            if u.path == "/api/notes":
                return self.send_json(load_notes())
            if u.path == "/api/align":
                return self.send_json(align(qs.get("artist", ""), qs.get("track", ""),
                                            float(qs.get("duration") or 0), qs.get("video", "")))
            if u.path == "/api/word":
                return self.send_json(word_meaning(qs.get("word", ""), qs.get("line", ""),
                                                   qs.get("artist", ""), qs.get("track", "")))
            if u.path == "/api/ytsearch":
                return self.send_json(yt_search(qs.get("q", "").strip(), 8))
            if u.path == "/api/songvideo":
                v = song_video(qs.get("q", "").strip(), float(qs.get("duration") or 0))
                return self.send_json({"id": v["id"], "title": v["title"], "thumb": v["thumb"]})
            if u.path == "/api/video":
                meta = download_video(qs.get("id", ""))
                return self.send_json({**meta, "url": "/cache/" + urllib.parse.quote(meta["file"])})
            if u.path == "/api/audio":
                q = qs.get("q", "").strip()
                dur = float(qs.get("duration") or 0)
                meta = download_audio(q, dur, qs.get("id", ""))
                return self.send_json({**meta, "url": "/cache/" + urllib.parse.quote(meta["file"])})
            if u.path.startswith("/cache/"):
                name = os.path.basename(urllib.parse.unquote(u.path[7:]))
                path = os.path.join(CACHE, name)
                if not os.path.isfile(path):
                    return self.send_error(404)
                ctype = {".mp4": "video/mp4", ".m4a": "audio/mp4"}.get(os.path.splitext(name)[1], "video/webm")
                size = os.path.getsize(path)
                # suporta "Range": o player busca só o pedaço que precisa (filmes grandes, pular trechos)
                start, end = 0, size - 1
                rng = self.headers.get("Range", "")
                m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
                if m and (m.group(1) or m.group(2)):
                    if m.group(1):
                        start = int(m.group(1))
                        end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
                    else:
                        start = max(0, size - int(m.group(2)))
                    if start > end:
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.end_headers()
                        return
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                else:
                    self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(end - start + 1))
                self.end_headers()
                try:
                    with open(path, "rb") as f:
                        f.seek(start)
                        left = end - start + 1
                        while left > 0:
                            chunk = f.read(min(1 << 16, left))
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            left -= len(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # o player cancelou o pedido (normal ao pular)
                return
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)
        return super().do_GET()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            if u.path == "/api/notes":
                with _notes_guard:
                    notes = load_notes()
                    if body.get("action") == "delete":
                        notes = [n for n in notes if n.get("id") != body.get("id")]
                    else:
                        n = body.get("note") or {}
                        term = " ".join(str(n.get("term", "")).split())[:120]
                        text = str(n.get("note", "")).strip()[:2000]
                        if not term or not text:
                            return self.send_json({"error": "preencha o trecho e a anotação"}, 400)
                        old = next((x for x in notes if x.get("id") == n.get("id")), None)
                        if old:
                            old.update(term=term, note=text, updated=int(time.time()))
                        else:
                            notes.insert(0, {"id": hashlib.sha1(f"{term}{time.time()}".encode()).hexdigest()[:12],
                                             "term": term, "note": text, "created": int(time.time()),
                                             "song": str(n.get("song", ""))[:200], "line": str(n.get("line", ""))[:300]})
                    save_notes(notes)
                return self.send_json(notes)
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)
        self.send_error(404)


def main():
    for stream in (sys.stdout, sys.stderr):  # console do Windows pode não aceitar emoji/acentos
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://127.0.0.1:{PORT}/"
    print(f"🎧 Inglês com Música rodando em {url}  (Ctrl+C para sair)")
    if not ytdlp_cmd():
        print("⚠️  yt-dlp não encontrado: só será possível usar arquivos de áudio do computador.")
    if os.environ.get("NO_BROWSER") != "1":
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nAté a próxima!")


if __name__ == "__main__":
    main()
