/**
 * What push content looks like while it is being edited, and the starter
 * templates a campaign can begin from.
 *
 * The form types live here rather than in the composer so a preset can
 * produce one without importing the page that renders it.
 */

/** One button under the notification, as edited in the form. */
export interface ActionForm {
  id: string;
  title: string;
  deepLinkUrl: string;
}

/** One carousel frame as edited in the form. Order is identity. */
export interface CarouselSlideForm {
  imageUrl: string;
  caption: string;
  deepLinkUrl: string;
}

export type TimerKind = 'fixed' | 'duration';
export type TimerDurationUnit = 'hours' | 'days';

/**
 * The four ways a notification can actually be drawn.
 *
 * Mutually exclusive, because the OS picks one rendering path: the Android
 * handler tries the carousel first, falls back to a big picture if that could
 * not be rendered, and otherwise posts the plain template. Everything else a
 * campaign carries — buttons, a countdown, a deep link, personalisation — is
 * a decoration on top of whichever one of these applies.
 */
export type PushLayout = 'text' | 'image' | 'carousel' | 'silent';

export const LAYOUT_LABELS: Record<PushLayout, string> = {
  text: 'Text',
  image: 'Image',
  carousel: 'Carousel',
  silent: 'Silent',
};

/**
 * What a preset fills into the composer.
 *
 * Deliberately the form's own shape, not the API payload: a preset is a
 * starting point someone then edits, so it has to land in the fields rather
 * than bypass them.
 */
export interface PresetContent {
  title: string;
  body?: string;
  imageUrl?: string;
  deepLinkUrl?: string;
  silent?: boolean;
  actions?: ActionForm[];
  iosCategory?: string;
  carousel?: CarouselSlideForm[];
  /**
   * Always a duration, never a fixed instant. A preset is reused by
   * definition, and a fixed moment would pass — every campaign started from
   * it afterwards would carry a countdown already over. The API enforces the
   * same rule on saved templates.
   */
  timerDurationHours?: number;
  data?: Record<string, string>;
}

export interface PushPreset {
  id: string;
  name: string;
  description: string;
  layout: PushLayout;
  /** What this preset adds beyond its layout, for the card. */
  highlights: string[];
  /**
   * Platform truths worth knowing before choosing this, shown with the
   * preview rather than discovered after a send.
   */
  caveats: string[];
  content: PresetContent;
}

const XIAOMI_NO_IMAGE =
  'Xiaomi devices on Mi Push show no image — MIUI draws the notification itself and has no image parameter.';
const IOS_NEEDS_SERVICE_EXTENSION =
  'On iOS the image needs a Notification Service Extension in the host app.';
const IOS_NEEDS_CONTENT_EXTENSION =
  'On iOS this needs a Notification Content Extension in the host app.';
const IOS_CATEGORY_NOTE =
  'iOS only shows buttons from a category the app registered at launch, so set the category to match.';
const ANDROID_CAROUSEL_NOTE =
  'On Android the carousel is the expanded view; collapsed stays the system template, which Android 12 and up require.';

/**
 * The starter set.
 *
 * In code rather than seeded rows: a preset should exist in every project
 * from the first day, and a seeded row drifts the moment someone edits it
 * while still being the thing new users are shown. Saving a campaign as a
 * template still writes a project row — that is the editable half.
 */
export const PUSH_PRESETS: PushPreset[] = [
  {
    id: 'announcement',
    name: 'Announcement',
    description: 'A short, plain message. Reaches every device and every channel.',
    layout: 'text',
    highlights: ['Works everywhere'],
    caveats: [],
    content: {
      title: 'We have something new for you',
      body: 'Open the app to take a look.',
    },
  },
  {
    id: 'promo-image',
    name: 'Promo with image',
    description: 'One picture under the message, and a tap that lands somewhere specific.',
    layout: 'image',
    highlights: ['Deep link'],
    caveats: [XIAOMI_NO_IMAGE, IOS_NEEDS_SERVICE_EXTENSION],
    content: {
      title: '{{firstName|Hey}}, this one is for you',
      body: 'A new drop just landed. Take a look before it goes.',
      imageUrl: 'https://example.com/promo.png',
      deepLinkUrl: 'myapp://offers',
    },
  },
  {
    id: 'flash-sale',
    name: 'Flash sale',
    description:
      'A countdown that ticks down on the device, with buttons to act or dismiss.',
    layout: 'image',
    highlights: ['Countdown', '2 buttons'],
    caveats: [
      XIAOMI_NO_IMAGE,
      IOS_NEEDS_SERVICE_EXTENSION,
      IOS_CATEGORY_NOTE,
      'Android draws the countdown with the system chronometer, so it stays correct without another send.',
    ],
    content: {
      title: '24 hours only — 30% off',
      body: 'Ends when the timer does.',
      imageUrl: 'https://example.com/sale.png',
      deepLinkUrl: 'myapp://sale',
      timerDurationHours: 24,
      iosCategory: 'SALE',
      actions: [
        { id: 'shop', title: 'Shop now', deepLinkUrl: 'myapp://sale' },
        { id: 'later', title: 'Remind me', deepLinkUrl: '' },
      ],
    },
  },
  {
    id: 'product-carousel',
    name: 'Product carousel',
    description:
      'Several images the recipient pages through, each landing somewhere of its own.',
    layout: 'carousel',
    highlights: ['3 slides', 'Per-slide links'],
    caveats: [XIAOMI_NO_IMAGE, IOS_NEEDS_CONTENT_EXTENSION, ANDROID_CAROUSEL_NOTE],
    content: {
      title: 'Picked for you',
      body: 'Swipe through this week’s selection.',
      imageUrl: 'https://example.com/carousel-1.png',
      deepLinkUrl: 'myapp://shop',
      carousel: [
        { imageUrl: 'https://example.com/carousel-1.png', caption: 'Trainers', deepLinkUrl: 'myapp://p/1' },
        { imageUrl: 'https://example.com/carousel-2.png', caption: 'Jackets', deepLinkUrl: 'myapp://p/2' },
        { imageUrl: 'https://example.com/carousel-3.png', caption: 'Bags', deepLinkUrl: 'myapp://p/3' },
      ],
    },
  },
  {
    id: 'cart-reminder',
    name: 'Cart reminder',
    description: 'A nudge about something left behind, with one way back to it.',
    layout: 'image',
    highlights: ['1 button', 'Personalised'],
    caveats: [XIAOMI_NO_IMAGE, IOS_NEEDS_SERVICE_EXTENSION, IOS_CATEGORY_NOTE],
    content: {
      title: '{{firstName|You}} left something behind',
      body: 'Your basket is still waiting.',
      imageUrl: 'https://example.com/cart.png',
      deepLinkUrl: 'myapp://cart',
      iosCategory: 'CART',
      actions: [{ id: 'checkout', title: 'Check out', deepLinkUrl: 'myapp://cart' }],
    },
  },
  {
    id: 're-engagement',
    name: 'Win-back',
    description: 'Plain copy addressed to someone who has not been back in a while.',
    layout: 'text',
    highlights: ['Personalised', 'Works everywhere'],
    caveats: [],
    content: {
      title: 'We miss you, {{firstName|there}}',
      body: 'Plenty has changed since your last visit in {{city|your area}}.',
      deepLinkUrl: 'myapp://home',
    },
  },
  {
    id: 'silent-sync',
    name: 'Background sync',
    description:
      'Wakes the app with data and shows nothing. No title, body or image is sent.',
    layout: 'silent',
    highlights: ['Custom data'],
    caveats: [
      'Nothing is displayed, so there is no impression or click to report — this will not appear in engagement figures.',
    ],
    content: {
      // A silent push shows nothing, but the campaign still needs a name to
      // be found by later: the composer uses the title as that name.
      title: 'Background sync',
      silent: true,
      data: { action: 'sync', scope: 'catalogue' },
    },
  },
];

export function findPreset(id: string): PushPreset | undefined {
  return PUSH_PRESETS.find((preset) => preset.id === id);
}

/**
 * What is composed, as far as a platform caveat is concerned.
 *
 * The composer's own fields rather than the API payload: these notes are
 * shown while someone is still editing, and there is no payload yet.
 */
export interface ComposedPush {
  silent: boolean;
  imageUrl: string;
  carouselSlides: number;
  hasTimer: boolean;
  actions: number;
  iosCategory: string;
}

/**
 * Platform truths worth knowing about what is currently composed.
 *
 * Driven by the content rather than by which preset was chosen, so they stay
 * right after a preset has been edited — and appear for a campaign built
 * from scratch too.
 *
 * Pure, and here rather than inline in the composer, for the same reason
 * `segment-form.ts` is: one of these notes is load-bearing and silent when
 * missing. A carousel or a countdown only reaches iOS through a Notification
 * Content Extension, and iOS chooses that extension by matching the
 * notification's `aps.category` against a `UNNotificationExtensionCategory`
 * compiled into the host app. With no category there is nothing to match, so
 * iOS draws the plain notification and the carousel is simply absent — no
 * error raised anywhere, on any side.
 *
 * Nor can it be caught anywhere else. The server cannot invent the string
 * (only the app defines it) and must not refuse the campaign for lacking it,
 * because Android builds its carousel from `RemoteViews` with no category
 * involved: an Android-only carousel is a legitimate campaign and has to
 * stay sendable. So this is a note, not an error, and this list is the only
 * place the author can be told.
 */
export function pushContentCaveats(composed: ComposedPush): string[] {
  const notes: string[] = [];

  if (composed.silent) {
    notes.push(
      'Nothing is displayed, so there is no impression or click to report — this will not appear in engagement figures.',
    );
    return notes;
  }

  const hasCarousel = composed.carouselSlides > 0;

  if (hasCarousel) {
    notes.push(
      'On Android the carousel is the expanded view; collapsed stays the system template, which Android 12 and up require.',
    );
    notes.push('On iOS a carousel needs a Notification Content Extension in the host app.');
  }
  if (composed.imageUrl.trim() || hasCarousel) {
    notes.push(
      'Xiaomi devices on Mi Push show no image — MIUI draws the notification itself and has no image parameter.',
    );
    notes.push('On iOS an image needs a Notification Service Extension in the host app.');
  }
  if (composed.hasTimer) {
    notes.push('On iOS a countdown needs a Notification Content Extension in the host app.');
  }

  // The extension exists in the app; the category is what selects it. There
  // is no platform picker in the composer — a campaign goes to whichever
  // tokens the audience holds — so this is addressed to iOS recipients
  // specifically rather than to a choice the author made.
  if ((hasCarousel || composed.hasTimer) && !composed.iosCategory.trim()) {
    notes.push(
      `iOS matches that extension by category, and this campaign sets none — iOS recipients will see a plain notification without the ${
        hasCarousel ? 'carousel' : 'countdown'
      }. Set the iOS category to the UNNotificationExtensionCategory your extension declares.`,
    );
  }
  if (composed.actions > 0 && !composed.iosCategory.trim()) {
    notes.push(
      'iOS shows buttons only from a category the app registered at launch — without an iOS category these appear on Android only.',
    );
  }

  return notes;
}
