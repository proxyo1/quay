# Wise PayNow payout probe

Re-run with `cd scripts && bun run wise-payout-probe.ts`. Read-only: it reads the
profile, creates a quote (free, non-committal, self-expiring), and reads the
account requirements. No recipient is created and no money moves.

**Env caveat.** The script defaults to `live` when `WISE_ENV` is unset, and line 7
of `scripts/.env.local` currently has `WISE_ENV=sandbox` **commented out**. The run
below therefore hit the production API. Uncomment that line to probe sandbox.

Last run: 2026-08-20, `env=live`, profile `type=personal`.

## The question

The mandatory PayNow micro-deposit sends S$0.01 to the UEN printed on a merchant's
SGQR sticker, carrying a reference code the merchant reads off their bank statement.
That only works if a payout rail can address a **UEN** proxy specifically. Mobile or
NRIC is not a substitute: the UEN is the proxy the sticker pays into, and control of
that account is the thing being proven.

## Result: UEN is supported

```
SGD payout types Wise offers (2):
  • type="singapore"         title="Local bank account"
  • type="singapore_paynow"  title="PayNow"

Required fields for singapore_paynow:
  accountNumber      text    "Mobile number or Unique Entity Number (UEN)"  required
  accountHolderName  text    "Full name of the account holder"              required
  legalType          select  "Recipient type"                               required
  address.country    select                                                 required
  address.city       text                                                   required
  address.firstLine  text    "Recipient address"                            required
  address.postCode   text    "Post code"                                    required
  email              text    "Email (Optional)"                             optional
```

Automated sending is viable. The manual-send rail is a starting point, not a
permanent constraint.

## The non-obvious part: ACRA feeds the send

`singapore_paynow` requires the recipient's **name and full address**. A scanned
SGQR sticker yields neither — it carries the UEN and little else.

ACRA's open data supplies both, but only from the right dataset. The two tiers are
not interchangeable here:

| Source | Gives | Enough to send? |
|---|---|---|
| UEN register (`d_3f960c10fed6145404ca7b821f263b87`) | entity name, `reg_street_name`, `reg_postal_code` | No — street and postal only, no block or line 1 |
| Corporate detail (27 per-letter datasets) | `block`, `street_name`, `building_name`, `level_no`, `unit_no`, `postal_code` | Yes |

So the ACRA lookup is **an input to the payout**, not merely name autofill, and the
detail lookup earns its second call. Note the detail datasets are keyed by the first
letter of the entity name, so the UEN register must be queried first to learn the
name, then the matching letter dataset for the address.

## Still open

The reference field length. `lib/server/wise.ts:213` slices `reference` to 35
characters, but the inbound PayNow customer reference a merchant reads on their own
statement is documented at 25, and receiving banks may truncate further. Only a real
send to a real account settles this. Keep the code short enough that it survives
either limit.
