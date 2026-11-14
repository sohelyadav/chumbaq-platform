# Razorpay fixtures

Copied verbatim from Razorpay's documentation (the code blocks of each page), so the
parser is tested against payloads Razorpay itself publishes rather than invented ones.
Do not edit them. A test that needs a variant changes only ids, timestamps, `plan_id`,
`status` or amounts, in the test, on a parsed copy.

| File | Source |
|---|---|
| `subscription.authenticated.json` | https://razorpay.com/docs/webhooks/subscriptions/ (`subscription.authenticated`) |
| `subscription.activated.json` | https://razorpay.com/docs/webhooks/subscriptions/ (`subscription.activated`, the example with a payment) |
| `subscription.charged.json` | https://razorpay.com/docs/webhooks/subscriptions/ (`subscription.charged`) |
| `subscription.pending.json` | https://razorpay.com/docs/webhooks/subscriptions/ (`subscription.pending`) |
| `subscription.halted.json` | https://razorpay.com/docs/webhooks/subscriptions/ (`subscription.halted`) |
| `subscription.cancelled.json` | https://razorpay.com/docs/webhooks/subscriptions/ (`subscription.cancelled`) |
| `subscription.completed.json` | https://razorpay.com/docs/webhooks/subscriptions/ (`subscription.completed`) |
| `subscription.updated.json` | https://razorpay.com/docs/webhooks/subscriptions/ (`subscription.updated`) |
| `payment.failed.json` | https://razorpay.com/docs/webhooks/payments/ (`payment.failed`, the first example) |
| `payment.downtime.started.json` | https://razorpay.com/docs/webhooks/payments/ (`payment.downtime.started`, the first example) |
| `invoice.paid.json` | https://razorpay.com/docs/webhooks/payloads/invoices/ (`invoice.paid`, the first example) |
| `invoice.expired.json` | https://razorpay.com/docs/webhooks/payloads/invoices/ (`invoice.expired`) |
| `refund.processed.json` | https://razorpay.com/docs/webhooks/payloads/refunds/ (`refund.processed`) |
| `invoices.list.json` | https://razorpay.com/docs/api/payments/subscriptions/fetch-invoices/ (response) |
| `plan.json` | https://razorpay.com/docs/api/payments/subscriptions/create-plan/ (response) |
| `subscription.json` | https://razorpay.com/docs/api/payments/subscriptions/create-subscription/ (response) |
| `customer.json` | https://razorpay.com/docs/api/customers/create/ (response) |

Quirks the parser must keep accepting, all from these examples: `captured` is `"1"` in
the subscription examples and `true` elsewhere; `notes` is `[]` on payments (and on one
subscription) but an object on others; `invoice.paid` has `"short_url": "https: //rzp.io/..."`
with a space; `customer.json` has a `"created_at "` key with a trailing space.

`subscription.activated.json` (the example with a payment) has the event's `created_at`
inside `payload` rather than at the top, unlike every other example; the parser refuses
it as it stands, and the specs move it up before using it.
