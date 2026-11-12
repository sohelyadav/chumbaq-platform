import { Check, Square, PanelBottom, PanelTop, Maximize } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  IN_APP_PRESETS, MESSAGE_TYPE_LABELS, type InAppPreset,
} from '@/lib/in-app-content';
import type { MessageType } from '@/hooks/use-in-app-messages';

/**
 * Starter shapes for an in-app message.
 *
 * Presets only. Unlike push there is no template table here — an existing
 * message is reused by duplicating it, which the campaign list already does,
 * so a second "saved" source would be two ways to do one thing.
 */

const TYPE_ICONS: Record<MessageType, typeof Square> = {
  modal: Square,
  bottom_sheet: PanelBottom,
  banner_top: PanelTop,
  banner_bottom: PanelBottom,
  fullscreen: Maximize,
};

export function InAppTemplateGallery({
  selectedPresetId,
  onSelect,
  onStartBlank,
}: {
  selectedPresetId: string;
  onSelect: (preset: InAppPreset) => void;
  onStartBlank: () => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Start from a template
        </p>
        <button
          type="button"
          onClick={onStartBlank}
          className={`text-xs ${
            selectedPresetId
              ? 'text-muted-foreground hover:underline'
              : 'font-medium text-primary'
          }`}
        >
          {selectedPresetId ? 'Start blank instead' : 'Starting blank'}
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {IN_APP_PRESETS.map((preset) => {
          const Icon = TYPE_ICONS[preset.content.messageType];
          const selected = selectedPresetId === preset.id;

          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => onSelect(preset)}
              aria-pressed={selected}
              className={`relative flex h-full flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors ${
                selected ? 'border-primary bg-primary/5' : 'hover:border-muted-foreground/40'
              }`}
            >
              {selected && (
                <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check className="h-3 w-3" />
                </span>
              )}
              <span className="flex items-center gap-2">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-sm font-medium">{preset.name}</span>
              </span>
              <span className="text-xs leading-snug text-muted-foreground">
                {preset.description}
              </span>
              <span className="mt-auto flex flex-wrap gap-1 pt-1">
                <Badge variant="secondary" className="text-[10px]">
                  {MESSAGE_TYPE_LABELS[preset.content.messageType]}
                </Badge>
                {preset.highlights.map((highlight) => (
                  <Badge key={highlight} variant="outline" className="text-[10px]">
                    {highlight}
                  </Badge>
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
