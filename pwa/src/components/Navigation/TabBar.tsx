import React from 'react';
import { Disc3, Library, ListMusic } from 'lucide-react';

export type TabId = 'now_playing' | 'catalog' | 'queue';

interface TabBarProps {
  activeTab: TabId;
  onSelectTab: (tab: TabId) => void;
  queueCount: number;
}

export const TabBar: React.FC<TabBarProps> = ({
  activeTab,
  onSelectTab,
  queueCount,
}) => {
  return (
    <nav className="shrink-0 bg-[#0D0E11]/95 backdrop-blur-md border-t border-zinc-800/60 px-6 pt-2 pb-[calc(var(--sab)+0.5rem)] z-30">
      <div className="flex items-center justify-around max-w-md mx-auto">
        {/* Now Playing Tab */}
        <button
          onClick={() => onSelectTab('now_playing')}
          className={`flex flex-col items-center justify-center py-1.5 px-3 min-w-[64px] min-h-[48px] rounded-xl transition-all ${
            activeTab === 'now_playing'
              ? 'text-[#D4AF37]'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <Disc3
            className={`w-6 h-6 transition-transform ${
              activeTab === 'now_playing' ? 'scale-110 animate-spin-slow' : ''
            }`}
            style={{ animationDuration: '8s' }}
          />
          <span className="text-[11px] font-medium mt-1">Playing</span>
        </button>

        {/* Catalog Tab */}
        <button
          onClick={() => onSelectTab('catalog')}
          className={`flex flex-col items-center justify-center py-1.5 px-3 min-w-[64px] min-h-[48px] rounded-xl transition-all ${
            activeTab === 'catalog'
              ? 'text-[#D4AF37]'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <Library
            className={`w-6 h-6 transition-transform ${
              activeTab === 'catalog' ? 'scale-110' : ''
            }`}
          />
          <span className="text-[11px] font-medium mt-1">Catalog</span>
        </button>

        {/* Queue Tab */}
        <button
          onClick={() => onSelectTab('queue')}
          className={`relative flex flex-col items-center justify-center py-1.5 px-3 min-w-[64px] min-h-[48px] rounded-xl transition-all ${
            activeTab === 'queue'
              ? 'text-[#D4AF37]'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <div className="relative">
            <ListMusic
              className={`w-6 h-6 transition-transform ${
                activeTab === 'queue' ? 'scale-110' : ''
              }`}
            />
            {queueCount > 0 && (
              <span className="absolute -top-1.5 -right-2 px-1.5 py-0.2 bg-[#D4AF37] text-zinc-950 text-[10px] font-bold rounded-full min-w-[16px] text-center">
                {queueCount}
              </span>
            )}
          </div>
          <span className="text-[11px] font-medium mt-1">Queue</span>
        </button>
      </div>
    </nav>
  );
};
