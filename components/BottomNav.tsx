'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CalendarDays, History, Pill, Settings } from 'lucide-react';

const items = [
  { href: '/', label: 'Hoje', icon: CalendarDays },
  { href: '/history', label: 'Histórico', icon: History },
  { href: '/medications', label: 'Medicamentos', icon: Pill },
  { href: '/settings', label: 'Configurações', icon: Settings }
];

export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Navegação principal" className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-200/80 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="mx-auto grid max-w-[760px] grid-cols-4 px-2 py-2">
        {items.map(item => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href} className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-2xl text-xs font-bold ${active ? 'text-sky-600 dark:text-sky-400' : 'text-slate-500 dark:text-slate-400'}`} aria-current={active ? 'page' : undefined}>
              <Icon size={22} aria-hidden="true" /> {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
