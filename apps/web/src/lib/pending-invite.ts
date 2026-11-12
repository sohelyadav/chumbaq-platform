/**
 * An invite link needs the invited account's own session, so a signed-out click has to
 * survive going through sign-in or sign-up. Shaped like `pendingVerification`: in this
 * tab only, and useless without the invited account. Only something shaped like the
 * API's token (32 random bytes, base64url) is read back.
 */
export const PENDING_INVITE_KEY = 'chumbaq_pending_invite';

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export const pendingInvite = {
  keep: (storage: Pick<Storage, 'setItem'>, token: string) => storage.setItem(PENDING_INVITE_KEY, token),
  read: (storage: Pick<Storage, 'getItem'>): string | null => {
    const value = storage.getItem(PENDING_INVITE_KEY);
    return value !== null && TOKEN_SHAPE.test(value) ? value : null;
  },
  clear: (storage: Pick<Storage, 'removeItem'>) => storage.removeItem(PENDING_INVITE_KEY),
};
