# APK Lab Relay

Um programa pequeno para Windows, Linux e macOS que deixa o [APK Browser Lab](https://madmax-dev-br.github.io/apk-browser-lab-site/) acessar qualquer servidor sem erro de CORS.

O navegador bloqueia as respostas de servidores que não autorizam a página do lab, e os servidores que um app Android real usa não autorizam. Com o relay aberto, o lab envia as requisições do app para este programa. Ele as repete a partir do seu computador, do jeito que o aparelho enviaria, e devolve a resposta ao lab.

## Baixar

Os executáveis estão em [Releases](../../releases/latest):

| Sistema | Arquivo |
| --- | --- |
| Windows (x64) | `apk-lab-relay-windows-x64.exe` |
| macOS (Apple Silicon) | `apk-lab-relay-macos-arm64.tar.gz` |
| macOS (Intel) | `apk-lab-relay-macos-x64.tar.gz` |
| Linux (x64) | `apk-lab-relay-linux-x64.tar.gz` |
| Linux (ARM64) | `apk-lab-relay-linux-arm64.tar.gz` |

`SHA256SUMS.txt` traz o hash de cada arquivo.

## Usar

1. Abra o programa. No Windows, dê dois cliques no `.exe`. No macOS e no Linux, extraia o `.tar.gz` e rode `./apk-lab-relay`.
2. Ele abre uma página de status no navegador (`http://127.0.0.1:8787/`) com o endereço do proxy. Copie o endereço.
3. No lab, vá em **Controles › Dispositivo › Proxy** e cole o endereço.
4. Deixe o programa aberto enquanto usa o lab. Fechar a janela (ou Ctrl+C) encerra.

O endereço tem um token aleatório. Ele fica salvo, então nas próximas vezes o endereço é o mesmo e você não precisa colar de novo.

### Avisos do sistema na primeira vez

Os executáveis não são assinados.

- **Windows:** o SmartScreen pode avisar "O Windows protegeu o computador". Clique em **Mais informações › Executar assim mesmo**.
- **macOS:** se o sistema recusar abrir, rode `xattr -d com.apple.quarantine ./apk-lab-relay` na pasta extraída, ou abra pelo Finder com clique direito › **Abrir**.

## Opções

```
apk-lab-relay [opções]
  --port <n>           porta em 127.0.0.1 (padrão 8787; fica salva)
  --origin <url>       página que pode usar o relay (repita para várias; fica salva)
  --allow-private      permite destinos neste computador e na rede local (fica salvo; --no-allow-private desliga)
  --token <texto>      usa este token no endereço (fica salvo)
  --new-token          gera um token novo (o endereço do Proxy muda)
  --no-open            não abre o navegador na página de status
  --version, --help
```

Por padrão, podem usar o relay o lab publicado (`https://madmax-dev-br.github.io`) e uma cópia local (`http://127.0.0.1:8765`, `http://localhost:8765`). Para usar o relay com o lab servido em outro endereço, passe `--origin http://localhost:5173`.

As configurações ficam em `%APPDATA%\apk-lab-relay` (Windows), `~/Library/Application Support/apk-lab-relay` (macOS) ou `~/.config/apk-lab-relay` (Linux).

## Segurança

- O relay escuta só em `127.0.0.1`: outro computador da rede não alcança.
- Cada requisição precisa trazer o token no caminho e vir de uma das páginas permitidas, então outro site aberto no mesmo navegador não consegue usar o relay.
- Destinos neste computador ou na rede local (loopback, 10.x, 192.168.x, ...) são recusados, a não ser com `--allow-private`.
- A página de status responde só a `127.0.0.1` e `localhost`, o que protege contra *DNS rebinding*.
- Nada é guardado além das configurações. Requisições e respostas passam e são esquecidas, e o histórico da página de status (as últimas 50, sem query string) fica só na memória.

## Como funciona

É o mesmo protocolo do `cors-relay.mjs` do lab:

- O destino vai no parâmetro `url`.
- Os cabeçalhos que o navegador não deixa enviar (Cookie, User-Agent, Origin, Referer...) chegam como `x-apkweb-<nome>` e saem com o nome original.
- Os redirecionamentos são seguidos aqui. Credenciais não seguem para outro host.
- Os `Set-Cookie` voltam no cabeçalho `x-apkweb-set-cookie`, como um array JSON.
- Quando o destino não responde, o relay devolve 502 com `x-apkweb-relay-error-code` (`ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`, `CERT_...`). O lab transforma esse código na exceção que o Android lançaria.

## Túnel TCP (gRPC, HTTP/2, outros protocolos)

Desde a 0.2.0, o relay também abre conexões TCP para o lab. Quando um app fala algo que não é HTTP/1.1 num socket (o gRPC do Cloud Firestore usa HTTP/2; MQTT; protocolos de banco de dados), o lab manda essa conexão pelo relay: a página abre um WebSocket em `ws://127.0.0.1:8787/<token>/tcp?host=…&port=…` e o relay conecta ao destino a partir do seu computador e repassa os bytes nos dois sentidos. Valem as mesmas regras do resto: só as páginas permitidas, só com o token, e destinos na rede local só com `--allow-private` (por exemplo, para os emuladores do Firebase rodando no seu computador).

## Desenvolver

Precisa de Node.js 22 ou mais recente.

```bash
npm ci
npm test
npm start          # roda o relay direto do código
npm run build      # gera o executável deste sistema em release/ (Node oficial, com suporte a single executable)
npm run smoke      # testa o executável gerado
```

## Publicar uma versão

O CI (`.github/workflows/build.yml`) roda os testes e gera os executáveis dos cinco sistemas a cada push. Para publicar uma versão:

1. Mude a versão em `package.json` e `VERSION` em `src/relay.cjs`.
2. Faça o commit e crie a tag: `git tag v0.2.0 && git push origin main v0.2.0`.

O CI cria a release com os executáveis e os checksums.
