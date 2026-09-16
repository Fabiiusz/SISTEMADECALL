# Meet Sales Copilot

Extensão do Chrome (Manifest V3) que funciona como **copiloto de vendas em tempo real** durante reuniões no Google Meet.
Enquanto você conversa, a extensão escuta a chamada, compara com o seu playbook e mostra num painel lateral:

1. **Em qual etapa da reunião você está**
2. **Checklist de perguntas obrigatórias**, marcado automaticamente quando você faz cada pergunta
3. **A próxima pergunta sugerida**
4. **Card amarelo de objeção** com a quebra de objeção pronta para falar, quando o lead levanta uma

> MVP para uso pessoal. A chave da API fica no `chrome.storage.local` do seu Chrome e é enviada apenas para a API do Google.
> A migração para um backend com tokens temporários é o próximo passo (veja "Próximos passos").

---

## Como funciona (arquitetura)

```
Google Meet (aba)                     Você (microfone)
      │ chrome.tabCapture                     │ getUserMedia
      ▼                                       ▼
┌───────────────────── offscreen document ──────────────────────┐
│  áudio da aba ──► alto-falantes (você continua ouvindo)       │
│  áudio da aba ──► PCM 16 kHz ──► Gemini Live (WS)  "LEAD"     │
│  microfone    ──► PCM 16 kHz ──► Gemini Live (WS)  "VENDEDOR" │
│                                     │ transcrição rotulada    │
│                                     ▼                         │
│        Gemini generateContent (JSON estruturado)              │
│        {etapa_atual, perguntas_feitas, proxima_pergunta,      │
│         objecao_detectada}                                    │
└───────────────────────────────┬───────────────────────────────┘
                                │ chrome.runtime.sendMessage
                                ▼
                     Painel lateral (chrome.sidePanel)
```

- **Captura**: o service worker gera o `streamId` da aba do Meet com `chrome.tabCapture.getMediaStreamId` e o
  offscreen document (obrigatório no MV3) abre os dois fluxos: aba (voz do lead) e microfone (sua voz). O áudio da aba é
  reproduzido de volta para que a chamada não fique muda.
- **Quem fala**: os dois fluxos nunca são misturados. Cada um vai para a sua própria sessão da Gemini Live API, e a
  transcrição volta rotulada como `LEAD` ou `VENDEDOR`.
- **IA**: as sessões Live (WebSocket, modelo `gemini-3.8-live`) fazem a transcrição em tempo real. A cada trecho novo, a
  transcrição rotulada é analisada com `gemini-3.8-flash` via `generateContent` com **schema JSON obrigatório**, que
  devolve exatamente:
  ```json
  {
    "etapa_atual": "diagnostico",
    "perguntas_feitas": ["ab_tempo", "dg_dor"],
    "proxima_pergunta": "Quanto esse problema custa para a empresa hoje?",
    "objecao_detectada": null
  }
  ```
  ou, quando há objeção, `"objecao_detectada": {"tipo": "preco", "resposta_sugerida": "..."}`.
- **Resiliência**: reconexão automática com retomada de sessão (`sessionResumption`) e compressão de contexto para
  reuniões longas; erros de chave, conexão e microfone aparecem no painel.

## Estrutura de arquivos

```
manifest.json               Manifest V3 (tabCapture, offscreen, sidePanel, storage, activeTab)
background.js               Service worker: abre o painel, gera o streamId da aba, cria/fecha o offscreen document
offscreen/
  offscreen.html / .js      Captura de áudio, playback, transcrição, análise e estado do copiloto
  pcm-worklet.js            AudioWorklet: float32 -> PCM 16 bits mono 16 kHz (+ nível de áudio)
  gemini-live.js            Cliente WebSocket da Gemini Live API (transcrição, reconexão, retomada)
  analyzer.js               Análise da conversa x playbook via generateContent com JSON schema
sidepanel/
  sidepanel.html / .css / .js   Painel lateral em pt-BR (etapa, checklist, próxima pergunta, objeção, transcrição)
options/
  options.html / .css / .js     Chave da API, modelos e playbook personalizado
permission/
  permission.html / .js     Página para conceder a permissão de microfone à extensão
shared/
  settings.js               Leitura/gravação de configurações (chrome.storage.local)
  playbook.js               Carregamento e validação do playbook
playbook.json               Playbook de exemplo (4 etapas, 3 objeções) - edite à vontade
icons/                      Ícones da extensão
```

## Passo a passo: instalar em modo desenvolvedor

1. Baixe ou clone este repositório numa pasta do seu computador.
2. Abra o Chrome (versão 116 ou mais nova) e acesse `chrome://extensions`.
3. Ative o **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** e escolha a pasta do projeto (a que contém `manifest.json`).
5. A extensão "Meet Sales Copilot" aparece na lista. Clique no ícone de quebra-cabeça na barra do Chrome e **fixe** a
   extensão para o ícone ficar visível.

## Configurar a chave da API do Gemini

1. Gere uma chave em [Google AI Studio](https://aistudio.google.com/apikey).
2. Em `chrome://extensions`, clique em **Detalhes** da extensão e depois em **Opções da extensão**
   (ou clique com o botão direito no ícone > Opções).
3. Cole a chave, clique em **Testar chave** (a página lista os modelos disponíveis na sua conta) e em **Salvar**.
4. Se o teste avisar que `gemini-3.8-live` ou `gemini-3.8-flash` não aparecem na sua conta, troque pelos nomes
   equivalentes que a lista mostrar (um modelo com "live" no nome para a transcrição e um modelo "flash" para a análise).

## Testar numa chamada do Meet

1. Entre numa reunião em `meet.google.com` (para testar sozinho, abra a reunião em outra conta ou peça a alguém para falar).
2. Com a **aba do Meet ativa**, clique no ícone da extensão. O painel lateral abre.
3. Clique em **Iniciar copiloto**.
   - Na primeira vez, o Chrome pede a permissão do **microfone**. Se o pedido não aparecer no painel, uma página da
     extensão abre para você conceder; depois volte ao painel e clique em Iniciar de novo.
   - O Chrome exige que a extensão tenha sido "invocada" na aba (o clique no ícone faz isso). Se aparecer um aviso sobre
     isso, clique no ícone da extensão com a aba do Meet aberta e tente de novo.
4. O indicador no topo fica **verde** ("Ouvindo a reunião") quando as duas conexões com a Gemini estão prontas.
5. Abra **Transcrição ao vivo** (na parte de baixo do painel) para conferir se o áudio está sendo captado:
   as barrinhas "Lead" e "Você" se mexem com o som, e as falas aparecem rotuladas como `LEAD` e `VENDEDOR`.
6. Faça as perguntas do playbook: o checklist marca cada uma automaticamente e a etapa avança.
7. Peça para o lead dizer algo como "está caro" ou "vou pensar": o card amarelo de objeção aparece com a resposta
   sugerida. Use o botão de copiar ou o "×" para dispensar.
8. Clique em **Parar** ao final. A captura da aba e do microfone é encerrada e o offscreen document é fechado.

**Dica**: use fones de ouvido. Sem eles, o microfone capta a voz do lead saindo dos alto-falantes, e a fala dele pode
aparecer também como `VENDEDOR`.

## Editar o playbook

Edite `playbook.json` e clique em **Atualizar** (ícone de recarregar) na extensão em `chrome://extensions`.
O formato:

```json
{
  "nome": "Meu playbook",
  "instrucoes_gerais": "Contexto que a IA deve considerar (opcional).",
  "etapas": [
    {
      "id": "abertura",
      "nome": "Abertura",
      "descricao": "Opcional",
      "perguntas": [
        { "id": "ab_tempo", "texto": "Você tem os 30 minutos combinados?" }
      ]
    }
  ],
  "objecoes": [
    {
      "id": "preco",
      "tipo": "Preço",
      "gatilhos": ["está caro", "não tenho orçamento"],
      "resposta": "Resposta base que a IA personaliza com o contexto da conversa."
    }
  ]
}
```

Regras: `id` de etapa, pergunta e objeção precisam ser únicos; use letras, números e `_`.
Também dá para colar um playbook na página de opções (campo "Playbook personalizado"), que substitui o arquivo sem
recarregar a extensão.

## Erros tratados

| Situação | O que o painel mostra |
|---|---|
| Sem chave da API | Aviso com botão "Abrir opções" |
| Chave inválida ou sem permissão | Aviso vindo da Gemini (WebSocket ou `generateContent`) |
| Permissão de microfone negada | Aviso com botão "Conceder microfone" (abre a página de permissão) |
| Aba ativa não é o Meet | Aviso pedindo para ativar a aba `meet.google.com` |
| Conexão com a Gemini caiu | Status amarelo "Reconectando..." com retomada de sessão; após 6 tentativas, erro e parada |
| Modelo não encontrado | Aviso para ajustar o nome do modelo nas opções |
| Limite de requisições (429) | Aviso; a análise tenta de novo no próximo trecho |

## Limitações do MVP

- A chave da API fica no navegador. Para uso em equipe, o plano é um backend que emita tokens temporários
  (a Live API aceita tokens efêmeros via `BidiGenerateContentConstrained`).
- Cada análise reenvia as últimas 40 falas da conversa; é simples e suficiente para reuniões de 30 a 60 minutos.
- Detecção de perguntas e objeções depende do modelo; ajuste os textos e os `gatilhos` do playbook para o seu vocabulário.
- Testado com o Chrome desktop. A captura de aba não funciona em navegadores móveis.

## Próximos passos sugeridos

1. Backend com tokens temporários (sem chave no cliente).
2. Histórico das reuniões (transcrição + checklist) salvo ao final.
3. Diarização dentro de um único fluxo, para quando houver mais de uma pessoa do lado do lead.
