'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { useLiveQuery } from 'dexie-react-hooks';

import {
  Bell,
  Download,
  Moon,
  ShieldAlert,
  Upload,
} from 'lucide-react';

import {
  db,
  defaultSettings,
} from '@/lib/db';

import type {
  AppSettings,
  Medication,
  MedicationLog,
} from '@/lib/types';

import {
  getPushStatus,
  registerServiceWorker,
  requestNotificationPermission,
  subscribeToPush,
  syncReminderJobs,
  testLocalNotification,
  unsubscribeFromPush,
} from '@/lib/reminder-client';

/* =========================================================
   TIPOS
========================================================= */

type BusyAction =
  | 'permission'
  | 'push'
  | 'disable'
  | 'test'
  | 'refresh'
  | 'backup'
  | 'import'
  | 'history'
  | 'reset'
  | null;

type PushStatusState = {
  supported: boolean;

  subscribed: boolean;

  permission:
    | NotificationPermission
    | 'unsupported';

  hasBrowserSubscription: boolean;

  backendMarkedSubscribed: boolean;

  standalone: boolean;

  ios?: boolean;
};

/* =========================================================
   HELPERS
========================================================= */

function getPermissionLabel(
  permission:
    | NotificationPermission
    | 'unsupported'
): string {
  switch (permission) {
    case 'granted':
      return 'Permitida';

    case 'denied':
      return 'Bloqueada';

    case 'default':
      return 'Ainda não solicitada';

    default:
      return 'Não suportada';
  }
}

function getErrorMessage(
  error: unknown,
  fallback: string
): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    typeof error === 'string' &&
    error.trim()
  ) {
    return error;
  }

  return fallback;
}

/* =========================================================
   COMPONENTE DE STATUS
========================================================= */

function StatusItem({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <p className="muted text-xs font-bold">
        {label}
      </p>

      <p
        className={`mt-1 text-sm font-black ${
          ok === true
            ? 'text-emerald-600 dark:text-emerald-400'
            : ok === false
              ? 'text-amber-600 dark:text-amber-400'
              : ''
        }`}
      >
        {value}
      </p>
    </div>
  );
}

/* =========================================================
   PÁGINA
========================================================= */

export default function SettingsPage() {
  const settings =
    useLiveQuery(
      () =>
        db.settings.get(
          'settings'
        )
    );

  const device =
    useLiveQuery(
      () =>
        db.device.get(
          'device'
        )
    );

  const fileRef =
    useRef<HTMLInputElement>(
      null
    );

  const [message, setMessage] =
    useState('');

  const [busy, setBusy] =
    useState<BusyAction>(
      null
    );

  const [
    pushStatus,
    setPushStatus,
  ] =
    useState<PushStatusState | null>(
      null
    );

  /* =======================================================
     STATUS DO PUSH
  ======================================================= */

  const refreshPushStatus =
    useCallback(
      async (
        showMessage = false
      ) => {
        try {
          const status =
            await getPushStatus();

          setPushStatus(
            status as PushStatusState
          );

          if (showMessage) {
            setMessage(
              'Status das notificações atualizado.'
            );
          }
        } catch (error) {
          console.error(
            '[Settings] Falha ao consultar status:',
            error
          );

          if (showMessage) {
            setMessage(
              getErrorMessage(
                error,
                'Não foi possível consultar o status do Push.'
              )
            );
          }
        }
      },
      []
    );

  /* =======================================================
     INICIALIZAÇÃO
  ======================================================= */

  useEffect(() => {
    let active = true;

    async function initialize() {
      try {
        /**
         * Prepara o Service Worker ANTES de o usuário
         * tocar no botão de ativação.
         *
         * Isso é muito importante no iPhone.
         */
        await registerServiceWorker();
      } catch (error) {
        console.warn(
          '[Settings] Falha ao preparar Service Worker:',
          error
        );
      }

      if (!active) {
        return;
      }

      await refreshPushStatus();
    }

    void initialize();

    return () => {
      active = false;
    };
  }, [refreshPushStatus]);

  /* =======================================================
     ALTERAR CONFIGURAÇÕES
  ======================================================= */

  async function syncAfterSettingsChange() {
    const currentDevice =
      await db.device.get(
        'device'
      );

    if (
      !currentDevice
        ?.pushSubscribed
    ) {
      return;
    }

    try {
      await syncReminderJobs();
    } catch (error) {
      console.warn(
        '[Settings] Configuração salva, mas sync falhou:',
        error
      );
    }
  }

  async function patchSettings(
    patch: Partial<AppSettings>,
    sync = false
  ) {
    await db.settings.update(
      'settings',
      patch
    );

    if (sync) {
      await syncAfterSettingsChange();
    }
  }

  /* =======================================================
     1. PERMISSÃO
  ======================================================= */

  async function allowNotifications() {
    if (busy) {
      return;
    }

    setBusy(
      'permission'
    );

    setMessage('');

    try {
      const permission =
        await requestNotificationPermission();

      if (
        permission ===
        'granted'
      ) {
        setMessage(
          'Permissão concedida. Agora toque em "2. Ativar Push".'
        );
      }

      await refreshPushStatus();
    } catch (error) {
      console.error(
        '[Settings] Permissão:',
        error
      );

      setMessage(
        getErrorMessage(
          error,
          'Não foi possível solicitar a permissão.'
        )
      );

      await refreshPushStatus();
    } finally {
      setBusy(null);
    }
  }

  /* =======================================================
     2. ATIVAR PUSH
  ======================================================= */

  async function enablePush() {
    if (busy) {
      return;
    }

    setBusy(
      'push'
    );

    setMessage('');

    try {
      /**
       * MUITO IMPORTANTE:
       *
       * NÃO coloque nenhum await antes desta chamada.
       *
       * No iOS, pushManager.subscribe() precisa ocorrer
       * diretamente a partir do clique do usuário.
       *
       * subscribeToPush() foi preparado justamente para
       * fazer pushManager.subscribe() antes de qualquer
       * operação assíncrona desnecessária.
       */
      await subscribeToPush();

      setMessage(
        'Push ativado com sucesso neste dispositivo.'
      );

      await refreshPushStatus();
    } catch (error) {
      console.error(
        '[Settings] Falha ao ativar Push:',
        error
      );

      setMessage(
        getErrorMessage(
          error,
          'Falha ao ativar Push.'
        )
      );

      await refreshPushStatus();
    } finally {
      setBusy(null);
    }
  }

  /* =======================================================
     DESATIVAR PUSH
  ======================================================= */

  async function disablePush() {
    if (busy) {
      return;
    }

    setBusy(
      'disable'
    );

    setMessage('');

    try {
      await unsubscribeFromPush();

      setMessage(
        'Push desativado neste dispositivo.'
      );

      await refreshPushStatus();
    } catch (error) {
      console.error(
        '[Settings] Falha ao desativar Push:',
        error
      );

      setMessage(
        getErrorMessage(
          error,
          'Não foi possível desativar o Push.'
        )
      );

      await refreshPushStatus();
    } finally {
      setBusy(null);
    }
  }

  /* =======================================================
     TESTE LOCAL
  ======================================================= */

  async function testNotification() {
    if (busy) {
      return;
    }

    setBusy(
      'test'
    );

    setMessage('');

    try {
      await testLocalNotification();

      setMessage(
        'Notificação de teste enviada. Este teste confirma permissão + Service Worker; não testa o cron do servidor.'
      );

      await refreshPushStatus();
    } catch (error) {
      console.error(
        '[Settings] Teste de notificação:',
        error
      );

      setMessage(
        getErrorMessage(
          error,
          'Falha ao enviar a notificação de teste.'
        )
      );

      await refreshPushStatus();
    } finally {
      setBusy(null);
    }
  }

  /* =======================================================
     ATUALIZAR STATUS
  ======================================================= */

  async function manualRefreshStatus() {
    if (busy) {
      return;
    }

    setBusy(
      'refresh'
    );

    setMessage('');

    try {
      await refreshPushStatus(
        true
      );
    } finally {
      setBusy(null);
    }
  }

  /* =======================================================
     EXPORTAR BACKUP
  ======================================================= */

  async function exportBackup() {
    if (busy) {
      return;
    }

    setBusy(
      'backup'
    );

    setMessage('');

    try {
      const [
        medications,
        logs,
        currentSettings,
      ] =
        await Promise.all([
          db.medications.toArray(),

          db.logs.toArray(),

          db.settings.get(
            'settings'
          ),
        ]);

      const data = {
        version: 1,

        exportedAt:
          new Date()
            .toISOString(),

        medications,

        logs,

        settings:
          currentSettings,
      };

      const blob =
        new Blob(
          [
            JSON.stringify(
              data,
              null,
              2
            ),
          ],
          {
            type:
              'application/json',
          }
        );

      const url =
        URL.createObjectURL(
          blob
        );

      const anchor =
        document.createElement(
          'a'
        );

      anchor.href =
        url;

      anchor.download =
        `medicamentos-backup-${
          new Date()
            .toLocaleDateString(
              'sv-SE'
            )
        }.json`;

      document.body.appendChild(
        anchor
      );

      anchor.click();

      anchor.remove();

      window.setTimeout(
        () => {
          URL.revokeObjectURL(
            url
          );
        },
        1000
      );

      setMessage(
        'Backup exportado.'
      );
    } catch (error) {
      console.error(
        '[Settings] Exportar backup:',
        error
      );

      setMessage(
        getErrorMessage(
          error,
          'Não foi possível exportar o backup.'
        )
      );
    } finally {
      setBusy(null);
    }
  }

  /* =======================================================
     IMPORTAR BACKUP
  ======================================================= */

  async function importBackup(
    file?: File
  ) {
    if (
      !file ||
      busy
    ) {
      return;
    }

    setBusy(
      'import'
    );

    setMessage('');

    try {
      const text =
        await file.text();

      /**
       * Primeiro tratamos tudo como unknown.
       */
      const data =
        JSON.parse(
          text
        ) as {
          medications?: unknown;
          logs?: unknown;
          settings?: Partial<AppSettings>;
        };

      /**
       * Validação mínima do arquivo.
       */
      if (
        !Array.isArray(
          data.medications
        )
      ) {
        throw new Error(
          'Backup inválido: lista de medicamentos não encontrada.'
        );
      }

      if (
        !Array.isArray(
          data.logs
        )
      ) {
        throw new Error(
          'Backup inválido: histórico não encontrado.'
        );
      }

      /**
       * IMPORTANTE:
       *
       * Criamos variáveis tipadas antes de entrar
       * no callback da transação Dexie.
       *
       * Isso corrige exatamente o erro da Vercel:
       *
       * Argument of type 'unknown' is not assignable...
       */
      const medications =
        data.medications as Medication[];

      const logs =
        data.logs as MedicationLog[];

      const importedSettings =
        data.settings;

      await db.transaction(
        'rw',

        db.medications,
        db.logs,
        db.settings,

        async () => {
          await db.medications.clear();

          await db.logs.clear();

          await db.medications.bulkPut(
            medications
          );

          await db.logs.bulkPut(
            logs
          );

          if (
            importedSettings
          ) {
            await db.settings.put({
              ...defaultSettings,
              ...importedSettings,
              id: 'settings',
            });
          }
        }
      );

      await syncAfterSettingsChange();

      setMessage(
        'Backup importado com sucesso.'
      );
    } catch (error) {
      console.error(
        '[Settings] Importar backup:',
        error
      );

      setMessage(
        getErrorMessage(
          error,
          'Não foi possível importar o backup.'
        )
      );
    } finally {
      setBusy(null);
    }
  }

  /* =======================================================
     APAGAR HISTÓRICO
  ======================================================= */

  async function clearHistory() {
    if (busy) {
      return;
    }

    const confirmed =
      window.confirm(
        'Apagar todo o histórico? Esta ação não remove os medicamentos cadastrados.'
      );

    if (!confirmed) {
      return;
    }

    setBusy(
      'history'
    );

    setMessage('');

    try {
      await db.logs.clear();

      await syncAfterSettingsChange();

      setMessage(
        'Histórico apagado.'
      );
    } catch (error) {
      console.error(
        '[Settings] Apagar histórico:',
        error
      );

      setMessage(
        getErrorMessage(
          error,
          'Não foi possível apagar o histórico.'
        )
      );
    } finally {
      setBusy(null);
    }
  }

  /* =======================================================
     RESTAURAR CONFIGURAÇÕES
  ======================================================= */

  async function resetSettings() {
    if (busy) {
      return;
    }

    const confirmed =
      window.confirm(
        'Restaurar as configurações padrão?'
      );

    if (!confirmed) {
      return;
    }

    setBusy(
      'reset'
    );

    setMessage('');

    try {
      await db.settings.put({
        ...defaultSettings,

        onboardingDone:
          true,
      });

      await syncAfterSettingsChange();

      setMessage(
        'Configurações restauradas.'
      );
    } catch (error) {
      console.error(
        '[Settings] Restaurar configurações:',
        error
      );

      setMessage(
        getErrorMessage(
          error,
          'Não foi possível restaurar as configurações.'
        )
      );
    } finally {
      setBusy(null);
    }
  }

  /* =======================================================
     LOADING
  ======================================================= */

  if (!settings) {
    return (
      <div>
        <header className="mb-5">
          <p className="muted text-sm font-bold">
            Preferências do aplicativo
          </p>

          <h1 className="text-3xl font-black">
            Configurações
          </h1>
        </header>

        <section className="card p-5">
          <p className="muted text-sm">
            Carregando configurações...
          </p>
        </section>
      </div>
    );
  }

  /* =======================================================
     STATUS DERIVADO
  ======================================================= */

  const permissionGranted =
    pushStatus
      ?.permission ===
    'granted';

  const permissionDenied =
    pushStatus
      ?.permission ===
    'denied';

  const pushActive =
    Boolean(
      pushStatus
        ?.subscribed
    );

  /* =======================================================
     UI
  ======================================================= */

  return (
    <div>
      <header className="mb-5">
        <p className="muted text-sm font-bold">
          Preferências do aplicativo
        </p>

        <h1 className="text-3xl font-black">
          Configurações
        </h1>
      </header>

      {/* ===================================================
          NOTIFICAÇÕES
      =================================================== */}

      <section className="card mb-4 p-5">
        <h2 className="flex items-center gap-2 text-lg font-black">
          <Bell size={20} />

          Notificações
        </h2>

        <p className="muted mt-2 text-sm leading-relaxed">
          Para receber lembretes mesmo com o aplicativo
          fechado, primeiro conceda a permissão do iPhone
          e depois ative o Web Push.
        </p>

        {/* IPHONE FORA DO PWA */}

        {pushStatus?.ios &&
          !pushStatus.standalone && (
            <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm font-bold text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
              No iPhone/iPad, abra este aplicativo pelo
              ícone instalado na Tela de Início. Não tente
              ativar Web Push em uma aba comum do Safari.
            </div>
          )}

        {/* PERMISSÃO BLOQUEADA */}

        {permissionDenied && (
          <div className="mt-4 rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm font-bold text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100">
            A permissão está bloqueada. Abra Ajustes →
            Notificações → Medicamentos e ative “Permitir
            Notificações”.
          </div>
        )}

        {/* STATUS */}

        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <StatusItem
            label="Suporte"
            value={
              pushStatus
                ? pushStatus.supported
                  ? 'Compatível'
                  : 'Não compatível'
                : 'Verificando...'
            }
            ok={
              pushStatus
                ? pushStatus.supported
                : undefined
            }
          />

          <StatusItem
            label="PWA"
            value={
              pushStatus
                ? pushStatus.standalone
                  ? 'Aberto como aplicativo'
                  : 'Aberto no navegador'
                : 'Verificando...'
            }
            ok={
              pushStatus
                ? pushStatus.standalone
                : undefined
            }
          />

          <StatusItem
            label="Permissão"
            value={
              pushStatus
                ? getPermissionLabel(
                    pushStatus.permission
                  )
                : 'Verificando...'
            }
            ok={
              pushStatus
                ? pushStatus.permission ===
                  'granted'
                : undefined
            }
          />

          <StatusItem
            label="Inscrição no navegador"
            value={
              pushStatus
                ? pushStatus
                    .hasBrowserSubscription
                  ? 'Criada'
                  : 'Não criada'
                : 'Verificando...'
            }
            ok={
              pushStatus
                ? pushStatus
                    .hasBrowserSubscription
                : undefined
            }
          />

          <StatusItem
            label="Backend"
            value={
              pushStatus
                ? pushStatus
                    .backendMarkedSubscribed
                  ? 'Registrado'
                  : 'Não registrado'
                : device
                    ?.pushSubscribed
                  ? 'Registrado'
                  : 'Verificando...'
            }
            ok={
              pushStatus
                ? pushStatus
                    .backendMarkedSubscribed
                : undefined
            }
          />

          <StatusItem
            label="Web Push"
            value={
              pushActive
                ? 'ATIVO'
                : 'INATIVO'
            }
            ok={
              pushActive
            }
          />
        </div>

        {/* AÇÕES */}

        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            className="btn-primary"
            disabled={
              Boolean(busy) ||
              permissionGranted
            }
            onClick={
              allowNotifications
            }
          >
            {busy ===
            'permission'
              ? 'Solicitando...'
              : permissionGranted
                ? '✓ Permissão concedida'
                : '1. Permitir notificações'}
          </button>

          <button
            type="button"
            className="btn-primary"
            disabled={
              Boolean(busy) ||
              !permissionGranted ||
              pushActive
            }
            onClick={
              enablePush
            }
          >
            {busy ===
            'push'
              ? 'Ativando Push...'
              : pushActive
                ? '✓ Push ativo'
                : '2. Ativar Push'}
          </button>

          <button
            type="button"
            className="btn-secondary"
            disabled={
              Boolean(busy) ||
              !permissionGranted
            }
            onClick={
              testNotification
            }
          >
            {busy ===
            'test'
              ? 'Enviando teste...'
              : 'Testar notificação'}
          </button>

          <button
            type="button"
            className="btn-secondary"
            disabled={
              Boolean(busy)
            }
            onClick={
              manualRefreshStatus
            }
          >
            {busy ===
            'refresh'
              ? 'Atualizando...'
              : 'Atualizar status'}
          </button>

          {(pushActive ||
            device
              ?.pushSubscribed ||
            pushStatus
              ?.hasBrowserSubscription) && (
            <button
              type="button"
              className="btn-secondary text-rose-600 sm:col-span-2"
              disabled={
                Boolean(busy)
              }
              onClick={
                disablePush
              }
            >
              {busy ===
              'disable'
                ? 'Desativando...'
                : 'Desativar Push neste dispositivo'}
            </button>
          )}
        </div>

        {/* PASSO A PASSO */}

        <div className="mt-5 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
          <p className="text-sm font-black">
            Ordem correta no iPhone
          </p>

          <ol className="muted mt-2 list-decimal space-y-1 pl-5 text-sm">
            <li>
              Abra o aplicativo pelo ícone da Tela de Início.
            </li>

            <li>
              Toque em “1. Permitir notificações”.
            </li>

            <li>
              No aviso do iPhone, toque em “Permitir”.
            </li>

            <li>
              Toque em “2. Ativar Push”.
            </li>

            <li>
              Confira se navegador, backend e Web Push
              ficaram ativos.
            </li>
          </ol>
        </div>

        {/* CONFIGURAÇÕES DE LEMBRETES */}

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <label className="flex gap-3 font-bold">
            <input
              type="checkbox"
              checked={
                settings
                  .soundEnabled
              }
              onChange={(
                event
              ) => {
                void patchSettings(
                  {
                    soundEnabled:
                      event.target
                        .checked,
                  },
                  true
                );
              }}
            />

            Som, quando suportado
          </label>

          <label className="flex gap-3 font-bold">
            <input
              type="checkbox"
              checked={
                settings
                  .vibrationEnabled
              }
              onChange={(
                event
              ) => {
                void patchSettings(
                  {
                    vibrationEnabled:
                      event.target
                        .checked,
                  },
                  true
                );
              }}
            />

            Vibração, quando suportada
          </label>

          <label>
            <span className="label">
              Intervalo padrão
            </span>

            <select
              className="input"
              value={
                settings
                  .repeatMinutes
              }
              onChange={(
                event
              ) => {
                void patchSettings(
                  {
                    repeatMinutes:
                      Number(
                        event.target
                          .value
                      ) as AppSettings['repeatMinutes'],
                  },
                  true
                );
              }}
            >
              {[
                10,
                15,
                30,
                45,
                60,
              ].map(
                (minutes) => (
                  <option
                    value={
                      minutes
                    }
                    key={
                      minutes
                    }
                  >
                    {minutes} minutos
                  </option>
                )
              )}
            </select>
          </label>

          <div>
            <label className="flex gap-3 font-bold">
              <input
                type="checkbox"
                checked={
                  settings
                    .quietHoursEnabled
                }
                onChange={(
                  event
                ) => {
                  void patchSettings(
                    {
                      quietHoursEnabled:
                        event.target
                          .checked,
                    },
                    true
                  );
                }}
              />

              Horário silencioso
            </label>

            {settings
              .quietHoursEnabled && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <input
                  aria-label="Início do silêncio"
                  className="input"
                  type="time"
                  value={
                    settings
                      .quietStart
                  }
                  onChange={(
                    event
                  ) => {
                    void patchSettings(
                      {
                        quietStart:
                          event.target
                            .value,
                      },
                      true
                    );
                  }}
                />

                <input
                  aria-label="Fim do silêncio"
                  className="input"
                  type="time"
                  value={
                    settings
                      .quietEnd
                  }
                  onChange={(
                    event
                  ) => {
                    void patchSettings(
                      {
                        quietEnd:
                          event.target
                            .value,
                      },
                      true
                    );
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ===================================================
          APARÊNCIA
      =================================================== */}

      <section className="card mb-4 p-5">
        <h2 className="flex items-center gap-2 text-lg font-black">
          <Moon size={20} />

          Aparência
        </h2>

        <div className="mt-4 grid grid-cols-3 gap-2">
          {(
            [
              [
                'system',
                'Automático',
              ],
              [
                'light',
                'Claro',
              ],
              [
                'dark',
                'Escuro',
              ],
            ] as const
          ).map(
            ([
              value,
              label,
            ]) => (
              <button
                type="button"
                key={value}
                className={`rounded-xl border px-2 py-3 text-sm font-black ${
                  settings
                    .theme ===
                  value
                    ? 'border-sky-500 bg-sky-50 dark:bg-sky-950'
                    : 'border-slate-200 dark:border-slate-700'
                }`}
                onClick={() => {
                  void patchSettings({
                    theme:
                      value,
                  });
                }}
              >
                {label}
              </button>
            )
          )}
        </div>
      </section>

      {/* ===================================================
          BACKUP
      =================================================== */}

      <section className="card mb-4 p-5">
        <h2 className="flex items-center gap-2 text-lg font-black">
          <Download size={20} />

          Dados e backup
        </h2>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            className="btn-secondary flex items-center justify-center gap-2"
            disabled={
              Boolean(busy)
            }
            onClick={
              exportBackup
            }
          >
            <Download
              size={17}
            />

            {busy ===
            'backup'
              ? 'Exportando...'
              : 'Exportar backup'}
          </button>

          <button
            type="button"
            className="btn-secondary flex items-center justify-center gap-2"
            disabled={
              Boolean(busy)
            }
            onClick={() => {
              fileRef.current
                ?.click();
            }}
          >
            <Upload
              size={17}
            />

            {busy ===
            'import'
              ? 'Importando...'
              : 'Importar backup'}
          </button>

          <input
            ref={
              fileRef
            }
            type="file"
            className="hidden"
            accept="application/json,.json"
            onChange={(
              event
            ) => {
              const input =
                event.currentTarget;

              const file =
                input.files?.[0];

              void importBackup(
                file
              ).finally(
                () => {
                  input.value =
                    '';
                }
              );
            }}
          />

          <button
            type="button"
            className="btn-secondary text-rose-600"
            disabled={
              Boolean(busy)
            }
            onClick={
              clearHistory
            }
          >
            {busy ===
            'history'
              ? 'Apagando...'
              : 'Apagar histórico'}
          </button>

          <button
            type="button"
            className="btn-secondary"
            disabled={
              Boolean(busy)
            }
            onClick={
              resetSettings
            }
          >
            {busy ===
            'reset'
              ? 'Restaurando...'
              : 'Restaurar configurações'}
          </button>
        </div>
      </section>

      {/* ===================================================
          SOBRE
      =================================================== */}

      <section className="card p-5">
        <h2 className="flex items-center gap-2 text-lg font-black">
          <ShieldAlert
            size={20}
          />

          Sobre e segurança
        </h2>

        <p className="muted mt-3 text-sm leading-relaxed">
          Este aplicativo é uma ferramenta de organização
          e lembrete e não substitui orientação médica.
          Ele não altera automaticamente dose, frequência
          ou tratamento.
        </p>

        <p className="muted mt-3 text-sm leading-relaxed">
          No iPhone/iPad: abra o endereço pelo Safari →
          Compartilhar → Adicionar à Tela de Início. Depois,
          abra pelo ícone instalado para utilizar Web Push.
        </p>
      </section>

      {/* ===================================================
          MENSAGEM
      =================================================== */}

      {message && (
        <div className="fixed bottom-24 left-1/2 z-50 w-[calc(100%-32px)] max-w-xl -translate-x-1/2 rounded-2xl bg-slate-900 p-4 text-center text-sm font-bold text-white shadow-xl dark:bg-white dark:text-slate-900">
          {message}
        </div>
      )}
    </div>
  );
}
