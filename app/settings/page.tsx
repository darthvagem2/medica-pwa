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
  cancelOccurrenceReminder,
  getPushStatus,
  registerServiceWorker,
  requestNotificationPermission,
  subscribeToPush,
  syncReminderJobs,
  testLocalNotification,
  unsubscribeFromPush,
} from '@/lib/reminder-client';

/**
 * Mantemos o import de cancelOccurrenceReminder acima
 * disponível para compatibilidade com reminder-client,
 * mesmo que esta página não precise chamá-lo diretamente.
 */
void cancelOccurrenceReminder;

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
            '[Settings] Falha ao consultar status Push:',
            error
          );

          if (showMessage) {
            setMessage(
              error instanceof Error
                ? error.message
                : 'Não foi possível consultar o status do Push.'
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
    let mounted = true;

    async function initialize() {
      try {
        await registerServiceWorker();
      } catch (error) {
        console.warn(
          '[Settings] Service Worker:',
          error
        );
      }

      if (!mounted) {
        return;
      }

      await refreshPushStatus();
    }

    void initialize();

    return () => {
      mounted = false;
    };
  }, [refreshPushStatus]);

  /* =======================================================
     UTILITÁRIOS
  ======================================================= */

  function errorMessage(
    error: unknown,
    fallback: string
  ): string {
    if (error instanceof Error) {
      return error.message;
    }

    return fallback;
  }

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
        '[Settings] Configuração salva localmente, mas sincronização falhou:',
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
     1. PEDIR PERMISSÃO
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
          'Permissão concedida. Agora toque em "Ativar Push" para concluir.'
        );
      }

      await refreshPushStatus();
    } catch (error) {
      setMessage(
        errorMessage(
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
       * Garante que o status que estamos vendo
       * não está desatualizado.
       */
      const currentStatus =
        await getPushStatus();

      if (
        currentStatus
          .permission ===
        'denied'
      ) {
        throw new Error(
          'As notificações estão bloqueadas. No iPhone, abra Ajustes → Notificações → Medicamentos e ative "Permitir Notificações".'
        );
      }

      if (
        currentStatus
          .permission !==
        'granted'
      ) {
        throw new Error(
          'Primeiro toque em "1. Permitir notificações". Depois volte e toque em "2. Ativar Push".'
        );
      }

      await subscribeToPush();

      await refreshPushStatus();

      setMessage(
        'Push ativado com sucesso neste dispositivo.'
      );
    } catch (error) {
      const text =
        errorMessage(
          error,
          'Falha ao ativar Push.'
        );

      setMessage(text);

      console.error(
        '[Settings] Falha ao ativar Push:',
        error
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

      await refreshPushStatus();

      setMessage(
        'Push desativado neste dispositivo.'
      );
    } catch (error) {
      setMessage(
        errorMessage(
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
        'Notificação de teste enviada. Este teste confirma a permissão e o Service Worker; ele não testa o cron do servidor.'
      );
    } catch (error) {
      setMessage(
        errorMessage(
          error,
          'Falha ao enviar a notificação de teste.'
        )
      );
    } finally {
      setBusy(null);
    }
  }

  /* =======================================================
     ATUALIZAR STATUS MANUALMENTE
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
     BACKUP
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
        () =>
          URL.revokeObjectURL(
            url
          ),
        1000
      );

      setMessage(
        'Backup exportado.'
      );
    } catch (error) {
      setMessage(
        errorMessage(
          error,
          'Não foi possível exportar o backup.'
        )
      );
    } finally {
      setBusy(null);
    }
  }

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

      const data =
        JSON.parse(
          text
        ) as {
          medications?: unknown;
          logs?: unknown;
          settings?: Partial<AppSettings>;
        };

      if (
        !Array.isArray(
          data.medications
        ) ||
        !Array.isArray(
          data.logs
        )
      ) {
        throw new Error(
          'Backup inválido.'
        );
      }

      await db.transaction(
        'rw',

        db.medications,
        db.logs,
        db.settings,

        async () => {
          await db.medications.clear();
          await db.logs.clear();

          await db.medications.bulkPut(
            data.medications
          );

          await db.logs.bulkPut(
            data.logs
          );

          if (
            data.settings
          ) {
            await db.settings.put({
              ...defaultSettings,
              ...data.settings,
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
      setMessage(
        errorMessage(
          error,
          'Não foi possível importar o backup.'
        )
      );
    } finally {
      setBusy(null);
    }
  }

  /* =======================================================
     HISTÓRICO
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
      setMessage(
        errorMessage(
          error,
          'Não foi possível apagar o histórico.'
        )
      );
    } finally {
      setBusy(null);
    }
  }

  /* =======================================================
     RESET
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
      setMessage(
        errorMessage(
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
          fechado, primeiro conceda a permissão e depois
          ative o Web Push.
        </p>

        {pushStatus?.ios &&
          !pushStatus.standalone && (
            <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm font-bold text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
              No iPhone/iPad, abra este site pelo ícone
              instalado na Tela de Início. O Web Push não
              deve ser ativado por uma aba comum do Safari.
            </div>
          )}

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
                ? pushStatus.hasBrowserSubscription
                  ? 'Criada'
                  : 'Não criada'
                : 'Verificando...'
            }
            ok={
              pushStatus
                ? pushStatus.hasBrowserSubscription
                : undefined
            }
          />

          <StatusItem
            label="Backend"
            value={
              pushStatus
                ? pushStatus.backendMarkedSubscribed
                  ? 'Registrado'
                  : 'Não registrado'
                : device?.pushSubscribed
                  ? 'Registrado'
                  : 'Verificando...'
            }
            ok={
              pushStatus
                ? pushStatus.backendMarkedSubscribed
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
            ok={pushActive}
          />
        </div>

        {/* BOTÕES PRINCIPAIS */}

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
            {busy === 'push'
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
            {busy === 'test'
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

        <div className="mt-5 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
          <p className="text-sm font-black">
            Ordem correta no iPhone
          </p>

          <ol className="muted mt-2 list-decimal space-y-1 pl-5 text-sm">
            <li>
              Abra pelo ícone da Tela de Início.
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
              O status deve mostrar navegador criado,
              backend registrado e Web Push ativo.
            </li>
          </ol>
        </div>

        {/* CONFIGURAÇÕES DOS LEMBRETES */}

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <label className="flex gap-3 font-bold">
            <input
              type="checkbox"
              checked={
                settings.soundEnabled
              }
              onChange={(event) =>
                void patchSettings(
                  {
                    soundEnabled:
                      event.target.checked,
                  },
                  true
                )
              }
            />

            Som, quando suportado
          </label>

          <label className="flex gap-3 font-bold">
            <input
              type="checkbox"
              checked={
                settings.vibrationEnabled
              }
              onChange={(event) =>
                void patchSettings(
                  {
                    vibrationEnabled:
                      event.target.checked,
                  },
                  true
                )
              }
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
                settings.repeatMinutes
              }
              onChange={(event) =>
                void patchSettings(
                  {
                    repeatMinutes:
                      Number(
                        event.target.value
                      ) as AppSettings['repeatMinutes'],
                  },
                  true
                )
              }
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
                    {minutes}{' '}
                    minutos
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
                onChange={(event) =>
                  void patchSettings(
                    {
                      quietHoursEnabled:
                        event.target
                          .checked,
                    },
                    true
                  )
                }
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
                    settings.quietStart
                  }
                  onChange={(event) =>
                    void patchSettings(
                      {
                        quietStart:
                          event.target
                            .value,
                      },
                      true
                    )
                  }
                />

                <input
                  aria-label="Fim do silêncio"
                  className="input"
                  type="time"
                  value={
                    settings.quietEnd
                  }
                  onChange={(event) =>
                    void patchSettings(
                      {
                        quietEnd:
                          event.target
                            .value,
                      },
                      true
                    )
                  }
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
                  settings.theme ===
                  value
                    ? 'border-sky-500 bg-sky-50 dark:bg-sky-950'
                    : 'border-slate-200 dark:border-slate-700'
                }`}
                onClick={() =>
                  void patchSettings({
                    theme:
                      value,
                  })
                }
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

            {busy === 'backup'
              ? 'Exportando...'
              : 'Exportar backup'}
          </button>

          <button
            type="button"
            className="btn-secondary flex items-center justify-center gap-2"
            disabled={
              Boolean(busy)
            }
            onClick={() =>
              fileRef.current
                ?.click()
            }
          >
            <Upload
              size={17}
            />

            Importar backup
          </button>

          <input
            ref={fileRef}
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
            {busy === 'reset'
              ? 'Restaurando...'
              : 'Restaurar configurações'}
          </button>
        </div>
      </section>

      {/* ===================================================
          SEGURANÇA
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
          abra sempre pelo ícone instalado para usar Web
          Push.
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
