# Inglês com Vídeo

App local para aprender inglês com vídeos do YouTube, como músicas, cenas de filmes, séries e podcasts. O vídeo pausa a cada frase, você escreve o que ouviu e depois vê a tradução, a explicação e exemplos.

## Como funciona

1. **Escolha:** busque uma música ou cole o link de um vídeo do YouTube.
2. **Ouça:** o vídeo pausa no fim de cada frase.
3. **Escreva:** digite as palavras e aprenda o significado.

Você também pode consultar o significado de uma palavra dentro da frase e salvar anotações.

## Como iniciar

É preciso ter o [Python 3.9 ou mais novo](https://www.python.org/downloads/). No Windows, marque a opção "Add python.exe to PATH" na instalação.

```bash
git clone https://github.com/ViniciusFazolo/learn-english-video.git
cd learn-english-video
python3 iniciar.py
```

No Windows, também dá para abrir com dois cliques no arquivo `iniciar.py`.

Na primeira vez, o app cria um ambiente isolado (`.venv`) e instala as dependências, o que pode levar alguns minutos. Depois disso, ele abre no navegador em `http://127.0.0.1:8765/`. Para encerrar, use `Ctrl+C` no terminal.

No Ubuntu/Debian, se der erro ao criar o ambiente, rode `sudo apt install python3-venv` e tente de novo.

## Tradução e explicações

O app usa a primeira opção disponível, nesta ordem:

| Ordem | Opção | O que você recebe |
|---|---|---|
| 1 | [Claude Code](https://claude.com/claude-code), com o login feito | Tradução, explicação, expressões e exemplos |
| 2 | [OpenCode](https://opencode.ai) | Tradução, explicação, expressões e exemplos |
| 3 | API gratuita do [MyMemory](https://mymemory.translated.net/) | Só a tradução, com limite de uso por dia |

Não é preciso configurar nada: o app procura o `claude` e o `opencode` instalados no computador. Sem nenhum dos dois, ele usa o MyMemory.

## Configuração opcional

| Variável | Para que serve | Padrão |
|---|---|---|
| `PORT` | Porta do servidor local | `8765` |
| `NO_BROWSER` | Com o valor `1`, não abre o navegador ao iniciar | desligado |
| `OPENCODE_MODEL` | Modelo do OpenCode, no formato `provedor/modelo` | modelo padrão do seu OpenCode |

Exemplo:

```bash
PORT=9000 OPENCODE_MODEL=opencode/big-pickle python3 iniciar.py
```

## Onde ficam os dados

- `dados/`: suas anotações. Não apague se quiser mantê-las.
- `cache/`: vídeos e áudios baixados e explicações já geradas. Pode ser apagada; o app baixa e gera tudo de novo quando precisar.

As duas pastas são criadas pelo app e ficam fora do git.
