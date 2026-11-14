// Super admin passkeys are required by default (webauthn.config.ts). Most integration
// specs sign staff in with a password and an authenticator code, so the suite starts
// with the requirement off, and the specs that test it turn it on themselves.
process.env.SUPER_ADMIN_PASSKEY_REQUIRED ??= 'false';

// No integration test sends real account mail: the .env file's Brevo key (loaded by
// int-db.ts and by ConfigModule, neither of which overrides a variable already set) is
// blanked here. Specs that test platform email set it themselves and answer Brevo's URL.
process.env.PLATFORM_BREVO_API_KEY = '';

// Nor does any integration test reach Razorpay: keys in the .env file are blanked, so
// billing is off and BILLING_PROVIDER is the null provider unless a spec sets fake keys
// (and overrides the provider with FakeBillingProvider) itself.
process.env.RAZORPAY_KEY_ID = '';
process.env.RAZORPAY_KEY_SECRET = '';
process.env.RAZORPAY_WEBHOOK_SECRET = '';
process.env.BILLING_ENABLED = '';
