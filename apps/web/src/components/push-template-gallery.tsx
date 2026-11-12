import { Check, FileText, Image as ImageIcon, Images, BellOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  PUSH_PRESETS, LAYOUT_LABELS, type PushLayout, type PushPreset,
} from '@/lib/push-content';
import type { PushTemplate } from '@/hooks/use-push-templates';

/**
 * Where a campaign starts: a built-in preset, or one of this project's own
 * saved templates.
 *
 * Two sources rather than one list, because they are different kinds of
 * thing. A preset ships with the product and always exists; a saved template
 * belongs to the project and records how often it has been used. Merging them
 * would make "most used first" meaningless for half the entries.
 */

const LAYOUT_ICONS: Record<PushLayout, typeof FileText> = {
  text: FileText,
  image: ImageIcon,
  carousel: Images,
  silent: BellOff,
};

function Tile({
  title,
  description,
  layout,
  badges,
  selected,
  onSelect,
}: {
  title: string;
  description: string;
  layout: PushLayout;
  badges: string[];
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = LAYOUT_ICONS[layout];

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`relative flex h-full flex-col gap-2 rounded-lg border p-3 text-left transition-colors ${
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
        <span className="text-sm font-medium">{title}</span>
      </span>
      <span className="text-xs leading-snug text-muted-foreground">{description}</span>
      <span className="mt-auto flex flex-wrap gap-1 pt-1">
        <Badge variant="secondary" className="text-[10px]">
          {LAYOUT_LABELS[layout]}
        </Badge>
        {badges.map((badge) => (
          <Badge key={badge} variant="outline" className="text-[10px]">
            {badge}
          </Badge>
        ))}
      </span>
    </button>
  );
}

/** A saved template's layout, inferred from what it actually carries. */
function templateLayout(template: PushTemplate): PushLayout {
  if (template.silent) return 'silent';
  if (template.carousel && template.carousel.length > 0) return 'carousel';
  if (template.imageUrl) return 'image';
  return 'text';
}

export function PushTemplateGallery({
  templates,
  selectedPresetId,
  selectedTemplateId,
  onSelectPreset,
  onSelectTemplate,
  onStartBlank,
}: {
  templates: PushTemplate[];
  selectedPresetId: string;
  selectedTemplateId: string;
  onSelectPreset: (preset: PushPreset) => void;
  onSelectTemplate: (id: string) => void;
  onStartBlank: () => void;
}) {
  const nothingChosen = !selectedPresetId && !selectedTemplateId;

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-sm font-medium">Start from a template</p>
          <button
            type="button"
            onClick={onStartBlank}
            className={`text-xs ${
              nothingChosen ? 'font-medium text-primary' : 'text-muted-foreground hover:underline'
            }`}
          >
            {nothingChosen ? 'Starting blank' : 'Start blank instead'}
          </button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {PUSH_PRESETS.map((preset) => (
            <Tile
              key={preset.id}
              title={preset.name}
              description={preset.description}
              layout={preset.layout}
              badges={preset.highlights}
              selected={selectedPresetId === preset.id}
              onSelect={() => onSelectPreset(preset)}
            />
          ))}
        </div>
      </div>

      {templates.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium">Saved in this project</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((template) => (
              <Tile
                key={template.id}
                title={template.name}
                description={
                  template.description ??
                  (template.useCount > 0
                    ? `Used ${template.useCount} time${template.useCount === 1 ? '' : 's'}`
                    : 'Not used yet')
                }
                layout={templateLayout(template)}
                badges={[
                  ...(template.actions?.length ? [`${template.actions.length} buttons`] : []),
                  ...(template.timer ? ['Countdown'] : []),
                  ...(template.translations ? ['Translated'] : []),
                ]}
                selected={selectedTemplateId === template.id}
                onSelect={() => onSelectTemplate(template.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
