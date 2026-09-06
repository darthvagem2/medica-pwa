# Medicamentos — PWA local-first

Aplicativo PWA para cadastro, lembretes, confirmação e histórico de medicamentos. O núcleo funciona sem conta e guarda medicamentos/configurações/logs em **IndexedDB (Dexie)**. Para lembretes confiáveis com o PWA fechado, o projeto inclui **Web Push + PostgreSQL + endpoint de agendamento**.

## O que está implementado

- Home responsiva com saudação, resumo, progresso, próximo horário, pendentes e atrasados.
- Cards por manhã/tarde/noite, botão grande **Tomei**, desfazer, atraso e prazo limite.
- CRUD real: adicionar, editar, remover, ativar/desativar e duplicar.
- Múltiplos horários por medicamento.
- Frequências: diária, dias da semana, a cada X dias e datas específicas; data inicial/final.
- Lembretes individuais com 10/15/30/45/60 minutos, som quando suportado e obrigatório/opcional.
- Caneta com rotação persistente Esquerdo ↔ Direito; a rotação só ocorre dentro da mesma transação que salva a confirmação.
- Alteração manual do próximo lado com confirmação.
- Identificador determinístico `medicationId__date__time` para impedir registros duplicados.
- Histórico com dose, previsto, tomado, atraso, situação e lado da aplicação.
- Calendário mensal com indicadores ✓ / ⚠ / ✕.
- Tema sistema/claro/escuro, safe areas iOS, navegação inferior, ARIA e reduced motion.
- Backup JSON, importação, apagar histórico e restaurar configurações.
- Manifest, Service Worker, cache offline, ícones, maskable icon, Apple Touch Icon e splash.
- Web Push com VAPID, inscrição/remoção e clique da notificação abrindo a ocorrência.
- Fila PostgreSQL com repetição até cancelamento e `FOR UPDATE SKIP LOCKED` para reduzir duplicação concorrente.
- Horário silencioso processado no fuso do dispositivo.
- Testes de domínio e da transação da caneta.


## Estrutura de pastas

```text
app/
  api/
    cron/reminders/        # worker HTTP da fila
    push/subscribe/        # registra PushSubscription
    push/unsubscribe/      # remove/desativa dispositivo
    reminders/sync/        # sincroniza ocorrências futuras
    reminders/cancel/      # cancela uma ocorrência confirmada
  history/                 # histórico + calendário
  medications/             # CRUD
  settings/                # notificações, aparência e dados
  layout.tsx
  page.tsx                 # Hoje
components/
lib/
  db.ts                    # IndexedDB/Dexie
  domain.ts                # recorrência/status/IDs
  local-actions.ts         # transações e rotação da caneta
  reminder-client.ts       # Service Worker/Push/sincronização
  server-db.ts             # PostgreSQL
  push-server.ts           # VAPID/web-push
public/
  icons/
  screenshots/
  manifest.webmanifest
  sw.js
  splash.png
tests/
schema.sql
vercel.json
vercel.cron-pro.example.json
.env.example
```

## Arquitetura dos lembretes

Uma PWA não pode confiar em `setInterval()` com o navegador fechado. Por isso existem duas camadas:

1. **Local-first:** IndexedDB guarda a verdade do usuário e a interface continua utilizável offline.
2. **Push em segundo plano:** o frontend envia ao backend somente o mínimo necessário para cada ocorrência futura (ID da ocorrência, rótulo, horário, deadline, repetição e URL). O PostgreSQL mantém a fila. Um scheduler chama `/api/cron/reminders`; o backend envia Web Push pelo Service Worker. Ao marcar **Tomei**, `/api/reminders/cancel` desativa imediatamente aquela ocorrência.

O backend não recebe dose nem histórico clínico. O histórico fica local neste projeto.

### Fluxo de uma ocorrência

- `next_notify_at = scheduled_at`, fase `main`.
- Ao enviar o lembrete principal, se houver deadline futuro, passa para fase `deadline` e agenda exatamente o deadline.
- Após deadline, passa para `repeat`, repetindo conforme 10/15/30/45/60 min.
- Confirmação => `active=false` para aquela ocorrência.
- No dia seguinte a ocorrência tem outro ID e não sobrescreve o histórico anterior.

## Requisitos

- Node.js 20+ (22 recomendado)
- PostgreSQL ou Supabase PostgreSQL para push em produção
- HTTPS em produção (Service Worker/Push exigem contexto seguro; localhost é aceito para desenvolvimento)

## Instalação local

```bash
npm install
cp .env.example .env.local
npm run dev
```

Abra `http://localhost:3000`.

O app local funciona sem PostgreSQL, mas **push agendado com o app fechado exige backend configurado**.

## Banco

Execute `schema.sql` no PostgreSQL/Supabase.

## VAPID

Gere as chaves:

```bash
npx web-push generate-vapid-keys
```

Preencha:

```env
NEXT_PUBLIC_VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:voce@exemplo.com
DATABASE_URL=postgresql://...
CRON_SECRET=uma-chave-forte
```

## Scheduler / Vercel

O `vercel.json` padrão não registra Cron, para que o projeto também faça deploy no plano Hobby. Atualmente, a Vercel limita Cron do Hobby a **uma execução por dia**, o que não serve para lembretes de medicamentos.

Em **Vercel Pro/Enterprise**, copie o conteúdo de `vercel.cron-pro.example.json` para `vercel.json`; o exemplo chama `/api/cron/reminders` **a cada minuto**.

No Hobby, mantenha o `vercel.json` padrão e configure um scheduler externo com cadência de 1 minuto para chamar:

```http
GET /api/cron/reminders
Authorization: Bearer <CRON_SECRET>
```

O backend decide quais ocorrências estão vencidas; chamar o endpoint a cada minuto não significa enviar uma notificação por minuto. A repetição de cada medicamento continua sendo 10/15/30/45/60 minutos.

## Publicação na Vercel

1. Suba o repositório para GitHub/GitLab/Bitbucket.
2. Importe na Vercel.
3. Configure as variáveis de `.env.example`.
4. Crie o PostgreSQL/Supabase e rode `schema.sql`.
5. Faça deploy.
6. Abra `/settings`, ative notificações e teste.

## iPhone/iPad

1. Abra o site publicado em **Safari**.
2. Toque **Compartilhar** → **Adicionar à Tela de Início**.
3. Abra o aplicativo pelo ícone criado.
4. Em Configurações → Notificações, toque em **Solicitar / ativar permissão**.

No iOS/iPadOS, Web Push depende do app estar instalado na Tela de Início. No iOS 26+, ao adicionar à Tela de Início, mantenha **Abrir como App / Open as Web App** ativado quando essa opção aparecer. Sons/vibração/`requireInteraction` continuam sujeitos às políticas do sistema operacional; o projeto não simula capacidades que o navegador não oferece.

## Android

Abra no Chrome/Edge → menu → **Instalar aplicativo** (ou aceite o prompt). Depois conceda notificações em Configurações do app.

## Desktop

Chrome/Edge mostram o botão de instalação na barra de endereço quando os critérios PWA são atendidos.

## Offline

O Service Worker usa cache da navegação e dos assets estáticos. Os dados do usuário permanecem no IndexedDB. A navegação principal é também naturalmente pré-carregada pelos links do Next.js quando online, deixando os chunks disponíveis para uso posterior.

## Fuso horário

As ocorrências são criadas no horário local do dispositivo e convertidas para ISO/UTC ao sincronizar com o servidor. O dispositivo envia seu `Intl.DateTimeFormat().resolvedOptions().timeZone`. Ao voltar ao app após viagem/mudança de fuso, os próximos jobs são sincronizados novamente. O cliente mantém uma janela rolante de 60 dias de ocorrências no servidor e renova essa janela em cada abertura/alteração; como o fluxo normal exige abrir o app para confirmar as doses, a janela é continuamente estendida.

## Segurança e privacidade

- `deviceId` aleatório + segredo local; o backend armazena somente hash SHA-256 do segredo.
- Uma inscrição só pode sincronizar/cancelar jobs se apresentar o segredo correspondente.
- O backend de push guarda apenas o necessário para entrega: subscription, timezone e metadados mínimos da ocorrência.
- Dose e histórico não são enviados ao backend.
- Para uma futura conta/sincronização, adicione autenticação e RLS antes de persistir dados médicos na nuvem.

## Testes

```bash
npm test
npm run build
```

Os testes cobrem: geração de ocorrência, atraso, repetição, dias da semana, alternância esquerda/direita, não alternar sem confirmação, duas confirmações rápidas e desfazer.

## Limitações reais da Web Platform

- Nenhuma PWA pode obrigar o sistema operacional a tocar som indefinidamente como um alarme nativo.
- O navegador/OS pode agrupar, silenciar ou atrasar notificações por economia de energia/foco/modos de silêncio.
- Em iOS, a disponibilidade de Web Push e seu comportamento dependem da versão e das permissões do sistema.
- O backend/scheduler é a estratégia usada aqui para não depender de timers JavaScript com o app fechado.

**Aviso:** este aplicativo é uma ferramenta de organização e lembrete e não substitui orientação médica. Ele não sugere nem altera doses, medicamentos ou tratamentos.
