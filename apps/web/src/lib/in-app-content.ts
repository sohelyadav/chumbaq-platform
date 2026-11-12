import type {
  MessageType,
  MessageButton,
  MessageTheme,
} from '@/hooks/use-in-app-messages';

/** The entity's own vocabulary; the hook types this as a bare string. */
export type ImagePosition = 'top' | 'center' | 'background';

/**
 * Starter shapes for an in-app message.
 *
 * In code rather than saved rows, for the same reason the push presets are: a
 * preset should exist in every project from the first day, and a row drifts
 * the moment someone edits it while still being what new users are shown.
 * Duplicating an existing message is the editable half here — there is no
 * template table for in-app messages and this does not add one.
 *
 * A preset carries presentation only — layout, copy, buttons, how it is
 * dismissed. Trigger, audience and schedule are left alone, because they are
 * decisions about *this* campaign rather than about its shape, and the editor
 * asks for them in their own steps.
 */

export const MESSAGE_TYPE_LABELS: Record<MessageType, string> = {
  modal: 'Modal',
  bottom_sheet: 'Bottom sheet',
  banner_top: 'Top banner',
  banner_bottom: 'Bottom banner',
  fullscreen: 'Fullscreen',
};

export interface InAppPresetContent {
  messageType: MessageType;
  title: string;
  body: string;
  imageUrl: string;
  imagePosition: ImagePosition;
  buttons: MessageButton[];
  /** Merged over the editor's defaults, so a preset only states what differs. */
  theme?: Partial<MessageTheme>;
  dismissOnTapOutside: boolean;
  autoDismissSeconds: number | null;
}

export interface InAppPreset {
  id: string;
  name: string;
  description: string;
  highlights: string[];
  content: InAppPresetContent;
}

/** Ids are stable within a preset; a message's own buttons are edited after. */
const button = (
  id: string,
  text: string,
  action: MessageButton['action'],
  style: MessageButton['style'],
  extra: Partial<MessageButton> = {},
): MessageButton => ({ id, text, action, style, ...extra });

export const IN_APP_PRESETS: InAppPreset[] = [
  {
    id: 'welcome',
    name: 'Welcome',
    description: 'A first-run greeting with one clear thing to do next.',
    highlights: ['Image', '1 button'],
    content: {
      messageType: 'modal',
      title: 'Welcome aboard',
      body: 'Here is the quickest way to get started.',
      imageUrl: 'https://example.com/welcome.png',
      imagePosition: 'top',
      buttons: [button('start', 'Get started', 'deep_link', 'primary', { actionUrl: 'myapp://onboarding' })],
      dismissOnTapOutside: true,
      autoDismissSeconds: null,
    },
  },
  {
    id: 'rating',
    name: 'Rating prompt',
    description: 'Asks for a review, with a graceful way to say not now.',
    highlights: ['2 buttons', 'No image'],
    content: {
      messageType: 'modal',
      title: 'Enjoying the app?',
      body: 'A quick rating helps other people find us.',
      imageUrl: '',
      imagePosition: 'top',
      buttons: [
        button('rate', 'Rate us', 'url', 'primary', { actionUrl: 'https://example.com/review' }),
        button('later', 'Maybe later', 'dismiss', 'text'),
      ],
      dismissOnTapOutside: true,
      autoDismissSeconds: null,
    },
  },
  {
    id: 'promo-fullscreen',
    name: 'Full-screen promo',
    description: 'An offer that takes the whole screen, over a background image.',
    highlights: ['Background image', '2 buttons'],
    content: {
      messageType: 'fullscreen',
      title: '30% off this weekend',
      body: 'Ends Sunday night.',
      imageUrl: 'https://example.com/promo.png',
      imagePosition: 'background',
      buttons: [
        button('shop', 'Shop the sale', 'deep_link', 'primary', { actionUrl: 'myapp://sale' }),
        button('close', 'No thanks', 'dismiss', 'text'),
      ],
      // A fullscreen message covers everything, so a stray tap dismissing it
      // would lose the offer by accident.
      dismissOnTapOutside: false,
      autoDismissSeconds: null,
    },
  },
  {
    id: 'feature-spotlight',
    name: 'Feature spotlight',
    description: 'Introduces something new without taking over the screen.',
    highlights: ['Image', '1 button'],
    content: {
      messageType: 'bottom_sheet',
      title: 'Try the new dashboard',
      body: 'Everything you track, on one screen.',
      imageUrl: 'https://example.com/feature.png',
      imagePosition: 'top',
      buttons: [button('see', 'Take a look', 'deep_link', 'primary', { actionUrl: 'myapp://dashboard' })],
      dismissOnTapOutside: true,
      autoDismissSeconds: null,
    },
  },
  {
    id: 'survey',
    name: 'Survey invite',
    description: 'A short ask for feedback, from the bottom of the screen.',
    highlights: ['2 buttons', 'Custom event'],
    content: {
      messageType: 'bottom_sheet',
      title: 'Got a minute?',
      body: 'Tell us what would make this better.',
      imageUrl: '',
      imagePosition: 'top',
      buttons: [
        button('survey', 'Start survey', 'url', 'primary', { actionUrl: 'https://example.com/survey' }),
        button('no', 'Not now', 'custom_event', 'secondary', { actionEvent: 'survey_declined' }),
      ],
      dismissOnTapOutside: true,
      autoDismissSeconds: null,
    },
  },
  {
    id: 'update-nudge',
    name: 'Update nudge',
    description: 'A thin bar at the top, out of the way of whatever they were doing.',
    highlights: ['1 button'],
    content: {
      messageType: 'banner_top',
      title: 'A new version is available',
      body: 'Update for the latest fixes.',
      imageUrl: '',
      imagePosition: 'top',
      buttons: [button('update', 'Update', 'url', 'text', { actionUrl: 'https://example.com/update' })],
      dismissOnTapOutside: true,
      autoDismissSeconds: null,
    },
  },
  {
    id: 'announcement-bar',
    name: 'Announcement bar',
    description: 'A note along the bottom that clears itself after a few seconds.',
    highlights: ['Auto-dismiss'],
    content: {
      messageType: 'banner_bottom',
      title: 'Free delivery this week',
      body: 'On every order over £20.',
      imageUrl: '',
      imagePosition: 'top',
      buttons: [],
      dismissOnTapOutside: true,
      // A banner with nothing to tap needs its own way out, or it sits there.
      autoDismissSeconds: 6,
    },
  },
];

export function findInAppPreset(id: string): InAppPreset | undefined {
  return IN_APP_PRESETS.find((preset) => preset.id === id);
}
