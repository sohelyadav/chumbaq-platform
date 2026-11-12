import { useEffect, useState } from 'react';
import { ImageOff, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ActionForm, CarouselSlideForm } from '@/lib/push-content';

/**
 * How a campaign will look on a device.
 *
 * Deliberately follows the SDKs' real rules rather than an idealised mock,
 * because a preview that flatters the payload is worse than none — it is
 * exactly the thing someone trusts instead of testing:
 *
 * - Android picks one layout. The handler tries the carousel first, falls
 *   back to a big picture when there is no carousel, and otherwise posts the
 *   plain template. So the preview never shows a carousel *and* a big picture.
 * - Only Android's expanded view is customised. Collapsed stays the system
 *   template, which is what Android 12 and up enforce, so the collapsed
 *   preview shows the picture as a small thumbnail rather than a banner.
 * - iOS shows buttons only from a category registered at launch, so they are
 *   drawn from `iosCategory` and labelled as the app's, not the campaign's.
 * - A silent push draws nothing at all.
 */

export type PreviewPlatform = 'android' | 'ios';

export interface PushPreviewContent {
  title: string;
  body: string;
  imageUrl: string;
  silent: boolean;
  actions: ActionForm[];
  iosCategory: string;
  carousel: CarouselSlideForm[];
  /** Seconds remaining, or null when the campaign carries no countdown. */
  countdownSeconds: number | null;
}

/** Placeholder art is the norm here — preset URLs point at example.com. */
function PreviewImage({
  src,
  className,
}: {
  src: string;
  className: string;
}) {
  const [failed, setFailed] = useState(false);

  // A new URL deserves a fresh attempt; without this, one broken address
  // leaves the placeholder showing for every later one.
  useEffect(() => setFailed(false), [src]);

  if (!src.trim() || failed) {
    return (
      <div
        className={`flex items-center justify-center bg-muted text-muted-foreground ${className}`}
      >
        <ImageOff className="h-5 w-5" />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      onError={() => setFailed(true)}
      className={`object-cover ${className}`}
    />
  );
}

function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function AndroidPreview({ content }: { content: PushPreviewContent }) {
  const [slide, setSlide] = useState(0);
  const slides = content.carousel.filter((s) => s.imageUrl.trim());
  const hasCarousel = slides.length > 0;
  const current = slides[Math.min(slide, slides.length - 1)];

  useEffect(() => { setSlide(0); }, [slides.length]);

  if (content.silent) {
    return (
      <div className="rounded-xl border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        Nothing is shown. The app is woken with data only.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Collapsed — the system template, always. */}
      <div className="rounded-xl border bg-card p-3 shadow-sm">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="h-3 w-3 rounded-sm bg-primary/70" />
          <span className="font-medium">Your app</span>
          <span>·</span>
          <span>
            {content.countdownSeconds !== null
              ? formatCountdown(content.countdownSeconds)
              : 'now'}
          </span>
        </div>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{content.title || 'Title'}</p>
            <p className="truncate text-sm text-muted-foreground">{content.body}</p>
          </div>
          {(hasCarousel || content.imageUrl.trim()) && (
            <PreviewImage
              src={hasCarousel ? current.imageUrl : content.imageUrl}
              className="h-10 w-10 shrink-0 rounded"
            />
          )}
        </div>
      </div>

      {/* Expanded — the only part a campaign can customise. */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="p-3 pb-2">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="h-3 w-3 rounded-sm bg-primary/70" />
            <span className="font-medium">Your app</span>
            <span>·</span>
            <span>
              {content.countdownSeconds !== null
                ? formatCountdown(content.countdownSeconds)
                : 'now'}
            </span>
          </div>
          <p className="text-sm font-semibold">{content.title || 'Title'}</p>
          {(hasCarousel ? current.caption || content.body : content.body) && (
            <p className="text-sm text-muted-foreground">
              {hasCarousel ? current.caption || content.body : content.body}
            </p>
          )}
        </div>

        {hasCarousel ? (
          <div>
            <PreviewImage src={current.imageUrl} className="h-40 w-full" />
            <div className="flex items-center justify-between border-t px-2 py-1.5 text-xs">
              <button
                type="button"
                className="flex items-center gap-1 rounded px-2 py-1 font-medium text-primary disabled:opacity-40"
                disabled={slide === 0}
                onClick={() => setSlide((i) => Math.max(0, i - 1))}
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Previous
              </button>
              <span className="text-muted-foreground">
                {Math.min(slide, slides.length - 1) + 1} of {slides.length}
              </span>
              <button
                type="button"
                className="flex items-center gap-1 rounded px-2 py-1 font-medium text-primary disabled:opacity-40"
                disabled={slide >= slides.length - 1}
                onClick={() => setSlide((i) => Math.min(slides.length - 1, i + 1))}
              >
                Next <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ) : (
          content.imageUrl.trim() && (
            <PreviewImage src={content.imageUrl} className="h-40 w-full" />
          )
        )}

        {content.actions.length > 0 && (
          <div className="flex flex-wrap gap-1 border-t px-2 py-1.5">
            {content.actions.map((action, i) => (
              <span
                key={`${action.id}-${i}`}
                className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-primary"
              >
                {action.title || 'Button'}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function IosPreview({ content }: { content: PushPreviewContent }) {
  if (content.silent) {
    return (
      <div className="rounded-xl border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        Nothing is shown. The app is woken with data only.
      </div>
    );
  }

  const slides = content.carousel.filter((s) => s.imageUrl.trim());
  const thumbnail = slides.length > 0 ? slides[0].imageUrl : content.imageUrl;

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border bg-card p-3 shadow-sm">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="h-3.5 w-3.5 rounded-[7px] bg-primary/70" />
          <span className="font-medium uppercase tracking-wide">YOUR APP</span>
          <span className="ml-auto">now</span>
        </div>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{content.title || 'Title'}</p>
            {content.body && <p className="text-sm text-muted-foreground">{content.body}</p>}
          </div>
          {thumbnail.trim() && (
            <PreviewImage src={thumbnail} className="h-11 w-11 shrink-0 rounded-md" />
          )}
        </div>
      </div>

      {(slides.length > 0 || content.countdownSeconds !== null) && (
        <p className="text-xs text-muted-foreground">
          Expanded, the carousel and countdown are drawn by a Notification
          Content Extension in the app. Without that target they are not shown
          — the banner above is all iOS displays.
        </p>
      )}

      {content.actions.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {content.iosCategory.trim()
            ? `Buttons come from the “${content.iosCategory}” category the app registered at launch, not from this campaign.`
            : 'No iOS category set, so iOS shows no buttons for this campaign — only Android will.'}
        </p>
      )}
    </div>
  );
}

export function PushPreview({
  content,
  platform,
  onPlatformChange,
}: {
  content: PushPreviewContent;
  platform: PreviewPlatform;
  onPlatformChange: (platform: PreviewPlatform) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="inline-flex rounded-md border p-0.5 text-sm">
        {(['android', 'ios'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onPlatformChange(option)}
            className={`rounded px-3 py-1 transition-colors ${
              platform === option
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {option === 'ios' ? 'iOS' : 'Android'}
          </button>
        ))}
      </div>

      {platform === 'android' ? (
        <AndroidPreview content={content} />
      ) : (
        <IosPreview content={content} />
      )}
    </div>
  );
}
