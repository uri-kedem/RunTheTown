# The store listing once sign-in is switched on

`APPSTORE.md` still describes the app without accounts: no sign-in, no data collected. **That
is out of date since Nov 24, 2026**, when signing in by an e-mail code was switched on (it
shows in the iPhone app too; Google and Apple do not yet). **The answers below now replace the
matching ones in `APPSTORE.md`.** The privacy page, the support page, the Terms & policy page
in the app and the app's privacy manifest already say the same.

Uri decides and files these; they are written here so nothing has to be worked out then.

## App Privacy ("nutrition label")

**Do you or your third-party partners collect data from this app?** → **Yes.**

Apple counts data as collected even when giving it is optional. Signing in is optional, and a
guest's data never leaves the phone, but what a signed-in runner's account keeps must be
declared. For every type below: purpose **App Functionality** only; **linked to the user**;
**not used for tracking**.

| Apple's type | What it is here |
| --- | --- |
| Contact Info → Email Address | The address of the account |
| Contact Info → Name | The profile name |
| User Content → Photos or Videos | The profile photo |
| Location → Precise Location | The GPS track of each saved run |
| Health & Fitness → Fitness | Each saved run: distance, time, pace |
| Identifiers → User ID | The account's id, and Apple's or Google's id for the person |

The same list is in the app's privacy manifest, `ios/App/App/PrivacyInfo.xcprivacy`
(`NSPrivacyCollectedDataTypes`), since Nov 24, 2026.

Not collected, as before: search history tied to a person, usage data, diagnostics,
advertising data. The relay still keeps answers and not who asked.

## App Review Information

**Sign-in required:** No. Signing in is optional; "Continue as a guest" on the first screen
uses the whole app.

Add to the notes for the reviewer:

> Signing in is optional. On the first screen "Continue as a guest" opens the full app with
> everything kept on the device. A runner may sign in with Apple, with Google, or with a
> six-digit code sent by e-mail (there is no password) to back up the profile and the run
> journal to the developer's server and see them on another device. No demo account is
> needed: use "Continue as a guest", or sign in with any e-mail address you can read.
> Account deletion: Menu → the profile row → "Delete my account" (tap twice). It removes the
> account and everything in it from the server at once.

## The guidelines this touches

- **5.1.1(v)**: the app is usable without a login (guest), and account deletion is offered
  inside the app.
- **4.8**: the iPhone app offers Google only when Sign in with Apple is offered beside it
  (`googleWay` in `js/app.js`). Today it offers the e-mail code alone, which is the app's own
  account system and needs no second sign-in service.
- Sign in with Apple and deletion: Apple asks that deleting an account also revokes the
  Sign in with Apple grant. Not built yet; see `server/README.md`. Check Apple's wording when
  the Developer Program enrolment is done.

## Description and "What's New"

A line for the description, if wanted: "Sign in (optional) to back up your runs and take
them to a new phone. No password: Apple, Google, or a code by e-mail."
