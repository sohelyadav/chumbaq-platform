/**
 * What Razorpay's create-customer API accepts, held in one place.
 *
 * Name: 3 to 50 characters, letters and digits with period, apostrophe, forward
 * slash, at sign and parentheses (and spaces). Email: at most 64 characters.
 * Anything else is a 400 from Razorpay, which would leave the account unable to
 * subscribe at all.
 *
 * The name at Razorpay is a label on its side only (the legal name on our own tax
 * invoices is kept as entered), so a legal name outside those rules is put into
 * them rather than refused: accents dropped, `&` spelt `and`, any other character
 * made a space, and anything past 50 characters cut at a word. Only a name with
 * too little left (fewer than 3 characters, or no letter or digit at all, as with a
 * name written wholly in a script other than Latin) and an email over 64
 * characters are refused, before any request.
 */
export const RAZORPAY_CUSTOMER_NAME_MIN = 3;
export const RAZORPAY_CUSTOMER_NAME_MAX = 50;
export const RAZORPAY_CUSTOMER_EMAIL_MAX = 64;

const NOT_ACCEPTED = /[^A-Za-z0-9 .'/@()]+/g;

/**
 * A customer detail Razorpay would refuse. Names the field only: the value is
 * personal data and stays out of the message.
 */
export class InvalidCustomerInputError extends Error {
  constructor(readonly field: 'name' | 'email') {
    super(
      field === 'name'
        ? 'The billing name needs at least 3 letters or digits in English characters'
        : `The billing email must be at most ${RAZORPAY_CUSTOMER_EMAIL_MAX} characters`,
    );
    this.name = 'InvalidCustomerInputError';
  }
}

/** The name as Razorpay will take it, or `InvalidCustomerInputError('name')`. */
export function razorpayCustomerName(name: string): string {
  if (typeof name !== 'string') throw new InvalidCustomerInputError('name');
  let accepted = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/&/g, ' and ')
    .replace(NOT_ACCEPTED, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (accepted.length > RAZORPAY_CUSTOMER_NAME_MAX) {
    const cut = accepted.slice(0, RAZORPAY_CUSTOMER_NAME_MAX);
    const lastSpace = cut.lastIndexOf(' ');
    const atWord = accepted.charAt(RAZORPAY_CUSTOMER_NAME_MAX) === ' ';
    accepted = (atWord || lastSpace < RAZORPAY_CUSTOMER_NAME_MIN ? cut : cut.slice(0, lastSpace)).trimEnd();
  }
  if (accepted.length < RAZORPAY_CUSTOMER_NAME_MIN || !/[A-Za-z0-9]/.test(accepted)) {
    throw new InvalidCustomerInputError('name');
  }
  return accepted;
}

/** The email as given, or `InvalidCustomerInputError('email')` past Razorpay's limit. */
export function razorpayCustomerEmail(email: string): string {
  if (typeof email !== 'string' || email.length === 0 || email.length > RAZORPAY_CUSTOMER_EMAIL_MAX) {
    throw new InvalidCustomerInputError('email');
  }
  return email;
}
